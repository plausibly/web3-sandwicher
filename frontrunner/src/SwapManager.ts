import "dotenv/config";
import {
  Pool,
  nearestUsableTick,
  TickMath,
  FeeAmount,
  TICK_SPACINGS,
} from "@uniswap/v3-sdk";
import { CurrencyAmount, Token } from "@uniswap/sdk-core";
import { ethers } from "ethers";
import JSBI from "jsbi";

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
  minVictimOut: bigint,
) {
  let poolSim = await getPoolObject(poolContract, tokenA, tokenB, fee);

  const attackerBuyFormat = CurrencyAmount.fromRawAmount(tokenA, JSBI.BigInt(attackerInput.toString()));
  const victimBuyFormat = CurrencyAmount.fromRawAmount(tokenA, JSBI.BigInt(victimInput.toString()));

  // Buying tokenB with provided tokenA
  let result = await poolSim.getOutputAmount(attackerBuyFormat);
  const attackerPurchasedAmount = result[0];

  console.log(`Attacker buys ${attackerPurchasedAmount.toExact()} AUC for ${attackerBuyFormat.toExact()} ETH`)

  // change pool state after the first buy
  poolSim = result[1];

  result = await poolSim.getOutputAmount(victimBuyFormat);
  //TODO how to compare Currency with BIgiNt?
  const victimPurchasedAmount = result[0];
  const vicPurchasedFormat = ethers.parseUnits(victimPurchasedAmount.toExact(), tokenB.decimals);
//   if (vicPurchasedFormat < minVictimOut) {
//     return 0;
//   }
  
  poolSim = result[1];
  console.log(`Victim buys ${victimPurchasedAmount.toExact()} AUC for ${victimBuyFormat.toExact()} ETH`)

  // How much tokenA if attacker sell tokenB
  result = await poolSim.getOutputAmount(attackerPurchasedAmount);
  const attackerSoldAmount = result[0];
  poolSim = result[1];

  console.log(`Attacker sells ${attackerPurchasedAmount.toExact()} AUC for ${attackerSoldAmount.toExact()} ETH`)

  const k = (attackerSoldAmount.subtract(attackerBuyFormat)).toExact();

  console.log("Profit before returned " + k)

  return k;
}

  