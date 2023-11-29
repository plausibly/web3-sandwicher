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
  Trade,
  SwapRouter,
  TickListDataProvider,
} from "@uniswap/v3-sdk";
import TickLensABI from "./contracts/ticklens.json";

import { CurrencyAmount, Percent, Token, TradeType } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import JSBI from "jsbi";
import { NETWORK, TICKLENS_ADDRESS } from "./config/info";

let tick_keys = [];

const BITMAP_FEE_TO_RANGES = {
  100: [-3466, 3465],
  500: [-347, 346],
  3000: [-58, 57],
  10000: [-18, 17],
};

/*
words per fee tier
6932  --- 0.01%
693   --- 0.05%
115   --- 0.3%
35    --- 1%
TickBtmpRange = {100:(-3466, 3465), 500: (-347, 346), 3000: (-58, 57), 10000: (-18, 17)}
*/

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
  const provider = new ethers.AlchemyProvider(
    NETWORK,
    process.env.ALCHEMY_API_KEY
  );
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
  const allTicks = new TickListDataProvider(
    await fetchAllTicks(poolContract, fee),
    tickSpacing
  );

  return new Pool(
    tokenA,
    tokenB,
    fee,
    sqrtPriceX96,
    liquidity,
    Number(slot0.tick),
    allTicks
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
    `Attacker buys ${attackerPurchasedAmount.toExact()} AUC for ${attackerBuyFormat.toExact()} ETH`
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
  // if (vicPurchasedFormat < minVictimOut) {
  //   return 0;
  // }

  poolSim = result[1];

  console.log(
    `Victim buys ${victimPurchasedAmount.toExact()} AUC for ${victimBuyFormat.toExact()} ETH`
  );

  // How much tokenA if attacker sell tokenB
  result = await poolSim.getOutputAmount(attackerPurchasedAmount);
  const attackerSoldAmount = result[0];
  poolSim = result[1];

  console.log(
    `Attacker sells ${attackerPurchasedAmount.toExact()} AUC for ${attackerSoldAmount.toExact()} ETH`
  );

  const k = attackerSoldAmount.subtract(attackerBuyFormat).toExact();

  console.log("Profit before returned " + k);

  return k;
}

export async function buildTradeParams(
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token,
  fee: FeeAmount,
  amountIn: string,
  expectedOut: string,
  recipient: string
) {
  const pool = await getPoolObject(poolContract, tokenA, tokenB, fee);

  const inputAmount = CurrencyAmount.fromRawAmount(tokenA, amountIn);
  const outputAmount = CurrencyAmount.fromRawAmount(tokenB, expectedOut);

  const route = new Route([pool], tokenA, tokenB);
  const trade = Trade.createUncheckedTrade({
    route,
    inputAmount,
    outputAmount,
    tradeType: TradeType.EXACT_INPUT,
  });

  const deadline = JSBI.BigInt(
    Math.floor(new Date().getTime() / 1000 + 3600 * 15)
  ); // expire ~15 mins from now

  const options = {
    slippageTolerance: new Percent(4, 100),
    recipient: recipient,
    deadline,
  };

  const params = SwapRouter.swapCallParameters([trade], options);

  return params;
}
