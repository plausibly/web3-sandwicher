import "dotenv/config";
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
} from "@uniswap/v3-sdk";
import TickLensABI from "./contracts/ticklens.json";

import { CurrencyAmount, Percent, Token, TradeType } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import JSBI from "jsbi";
import { TICKLENS_ADDRESS } from "./config/info";

export async function getPoolObject(
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token,
  fee: FeeAmount
) {
  const slot0 = await poolContract.slot0();
  const liquidity = JSBI.BigInt((await poolContract.liquidity()).toString());
  const sqrtPriceX96 = JSBI.BigInt(slot0.sqrtPriceX96.toString());

  return new Pool(
    tokenA,
    tokenB,
    fee,
    sqrtPriceX96,
    liquidity,
    Number(slot0.tick),
    [
      {
        index: nearestUsableTick(TickMath.MIN_TICK, TICK_SPACINGS[fee]),
        liquidityNet: liquidity,
        liquidityGross: liquidity,
      },
      {
        index: nearestUsableTick(TickMath.MAX_TICK, TICK_SPACINGS[fee]),
        liquidityNet: JSBI.multiply(liquidity, JSBI.BigInt("-1")),
        liquidityGross: liquidity,
      },
    ]
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
  console.log(poolSim.tickDataProvider);

  //  ethers.parseEther("0.001").toString();

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
  console.log(poolSim.tickCurrent);
  console.log(poolSim.tickDataProvider);

  result = await poolSim.getOutputAmount(victimBuyFormat);
  //TODO how to compare Currency with BIgiNt?
  const victimPurchasedAmount = result[0];
  const vicPurchasedFormat = ethers.parseUnits(
    victimPurchasedAmount.toExact(),
    tokenB.decimals
  );
  //   if (vicPurchasedFormat < minVictimOut) {
  //     return 0;
  //   }

  poolSim = result[1];
  console.log(poolSim.tickCurrent);

  console.log(
    `Victim buys ${victimPurchasedAmount.toExact()} AUC for ${victimBuyFormat.toExact()} ETH`
  );

  // How much tokenA if attacker sell tokenB
  result = await poolSim.getOutputAmount(attackerPurchasedAmount);
  const attackerSoldAmount = result[0];
  poolSim = result[1];
  console.log(poolSim.tickCurrent);

  console.log(
    `Attacker sells ${attackerPurchasedAmount.toExact()} AUC for ${attackerSoldAmount.toExact()} ETH`
  );

  const k = attackerSoldAmount.subtract(attackerBuyFormat).toExact();

  console.log("Profit before returned " + k);

  return k;
}

export async function getNextTick(
  poolContract: ethers.Contract,
  tick: number,
  tickSpacing: number,
  lte: boolean
) {
  let compressed = Math.floor(tick / tickSpacing);
  const bitmap = async (t: number) => await poolContract.tickBitmap(t);
  let initialized = false;
  let next = -1;

  while (!initialized) {
    if (compressed < 0 && tick % tickSpacing !== 0) {
      compressed--;
    }

    if (lte) {
      const wordPos = compressed >> 8;
      const bitPos = compressed % 256;

      const mask = (1 << bitPos) - 1 + (1 << bitPos);
      const masked = Number(await bitmap(wordPos)) & mask;
      initialized = masked !== 0;
      next = initialized
        ? compressed -
          (bitPos - mostSignificantBit(JSBI.BigInt(masked))) * tickSpacing
        : (compressed - bitPos) * tickSpacing;
    } else {
      let tmp = compressed + 1;
      const wordPos = tmp >> 8;
      const bitPos = tmp % 256;

      const mask = ~((1 << bitPos) - 1);
      const masked = Number(await bitmap(wordPos)) & mask;
      initialized = masked !== 0;
      next = initialized
        ? tmp + ((masked & 1) - bitPos) * tickSpacing
        : tmp + (2 ** 8 - 1 - bitPos) * tickSpacing;
    }
  }

  return { next, initialized };
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

  const params = SwapRouter.swapCallParameters([trade], options);

  return params;
}
