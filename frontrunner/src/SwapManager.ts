import {
  Pool,
  nearestUsableTick,
  TickMath,
  FeeAmount,
  TICK_SPACINGS,
  Tick,
  TickLibrary,
  mostSignificantBit,
  Route,
  TickListDataProvider,
  TickDataProvider,
} from "@uniswap/v3-sdk";
import TickLensABI from "./contracts/ticklens.json";
import { SwapRouter, UniswapTrade } from "@uniswap/universal-router-sdk"
import {Trade} from "@uniswap/router-sdk"
import { provider } from "./config/info";
import { CurrencyAmount, Percent, Token, TradeType, Currency} from "@uniswap/sdk-core";
import { ethers } from "ethers";
import JSBI from "jsbi";
import { NETWORK, TICKLENS_ADDRESS } from "./config/info";

const BITMAP_FEE_TO_RANGES = {
  100: [-3466, 3465],
  500: [-347, 346],
  3000: [-58, 57],
  10000: [-18, 17],
};

let TICK_DATA_ARRAY: TickListDataProvider | undefined;

/*
words per fee tier
6932  --- 0.01%
693   --- 0.05%
115   --- 0.3%
35    --- 1%
TickBtmpRange = {100:(-3466, 3465), 500: (-347, 346), 3000: (-58, 57), 10000: (-18, 17)}
*/

/**
 * Clear the loaded ticks so we can prep for next transaction.
 */
export function clearLoadedTicks() {
  TICK_DATA_ARRAY = undefined;
}

/**
 * Get all ticks from the tick bitmap for a given pool. Credits to uniswap discord for helping
 * @param poolContract 
 * @param fee 
 * @returns List of tick objects
 */
export async function fetchAllTicks(
  poolContract: ethers.Contract,
  fee: FeeAmount
) {
  const lensContract = new ethers.Contract(
    TICKLENS_ADDRESS,
    TickLensABI,
    provider
  );

  const feeRange: number[] = BITMAP_FEE_TO_RANGES[fee];

  let tickArr = [];
  for (let x = feeRange[0]; x <= feeRange[1]; x++) {
    let rawData = await lensContract.getPopulatedTicksInWord(poolContract, x);
    for (let i = 0; i < rawData.length; i++) {
      const tick = new Tick({
        index: Number(rawData[i].tick),
        liquidityNet: JSBI.BigInt(rawData[i].liquidityNet.toString()),
        liquidityGross: JSBI.BigInt(rawData[i].liquidityGross.toString()),
      });

      tickArr.push(tick);
    }
  }

  tickArr.sort((a, b) => Number(a.index) - Number(b.index));

  return tickArr;
}

export async function getPoolObject(
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token,
  fee: FeeAmount
) {
  const slot0 = await poolContract.slot0();
  const liquidity = JSBI.BigInt((await poolContract.liquidity()).toString());
  const sqrtPriceX96 = JSBI.BigInt(slot0.sqrtPriceX96.toString());
  const tickSpacing = TICK_SPACINGS[fee];

  if (!TICK_DATA_ARRAY) {
    TICK_DATA_ARRAY = new TickListDataProvider(
      await fetchAllTicks(poolContract, fee),
      tickSpacing
    );
  }

  return new Pool(
    tokenA,
    tokenB,
    fee,
    sqrtPriceX96,
    liquidity,
    Number(slot0.tick),
    TICK_DATA_ARRAY
  );
}

/**
 * Given a pool contract and the parameters, simulate a sandwich attack and calculate the profit gained. Returns 0 if
 * victim slippage is exceeded.
 * @param poolContract
 * @param tokenA
 * @param tokenB
 * @param fee
 * @param attackerInput
 * @param victimInput
 * @param minVictimOut
 * @returns
 */
export async function simulateAttack(
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token,
  fee: FeeAmount,
  attackerInput: bigint,
  victimInput: bigint,
  minVictimOut: bigint
) {
  let poolSim = await getPoolObject(poolContract, tokenA, tokenB, fee);

  const attackerBuyFormat = CurrencyAmount.fromRawAmount(
    tokenA,
    attackerInput.toString()
  );
  const victimBuyFormat = CurrencyAmount.fromRawAmount(
    tokenA,
    victimInput.toString()
  );

  // Buying tokenB with provided tokenA
  let result = await poolSim.getOutputAmount(attackerBuyFormat);
  const attackerPurchasedAmount = result[0];

  console.log(
    `Attacker buys ${attackerPurchasedAmount.toExact()} Token B for ${attackerBuyFormat.toExact()} ETH`
  );

  // change pool state after the first buy
  poolSim = result[1];

  result = await poolSim.getOutputAmount(victimBuyFormat);
  //TODO how to compare Currency with BIgiNt?
  const victimPurchasedAmount = result[0];
  const vicPurchasedFormat = ethers.parseUnits(
    victimPurchasedAmount.toExact(),
    tokenB.decimals
  );
  if (vicPurchasedFormat < minVictimOut) {
    console.log("Attacking would exceed slippage. Abort");
    clearLoadedTicks();
    return 0;
  }

  poolSim = result[1];

  console.log(
    `Victim buys ${victimPurchasedAmount.toExact()} Token B for ${victimBuyFormat.toExact()} ETH`
  );

  // How much tokenA if attacker sell tokenB
  result = await poolSim.getOutputAmount(attackerPurchasedAmount);
  const attackerSoldAmount = result[0];
  poolSim = result[1];

  console.log(
    `Attacker sells ${attackerPurchasedAmount.toExact()} Token B for ${attackerSoldAmount.toExact()} ETH`
  );

  return attackerSoldAmount.subtract(attackerBuyFormat).toExact();
}

export async function buildTradeParams(
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token,
  fee: FeeAmount,
  amountIn: string,
  recipient: string
) {
  const pool = await getPoolObject(poolContract, tokenA, tokenB, fee);

  const inputAmount = CurrencyAmount.fromRawAmount(tokenA, amountIn);
  const route = new Route([pool], tokenA, tokenB);
  const trade = await Trade.fromRoute(
    route,
    inputAmount,
    TradeType.EXACT_INPUT,
  );
  // Get the current time in milliseconds since the Unix epoch
  const currentTimeMillis = Date.now();

  // Calculate the time 15 minutes from now
  const fifteenMinutesInMillis = 15 * 60 * 1000; // 15 minutes in milliseconds
  const futureTimeMillis = currentTimeMillis + fifteenMinutesInMillis;

  // Convert the future time to seconds (Epoch time is usually in seconds)
  const futureTimeInSeconds = Math.floor(futureTimeMillis / 1000);

  const options = {
    slippageTolerance: new Percent(1, 100),
    recipient: recipient,
    deadline: futureTimeInSeconds,
  };

  const uniswapTrade = new UniswapTrade(trade, options);

  const params = SwapRouter.swapCallParameters(uniswapTrade, options);
  clearLoadedTicks();
  return params;
}
