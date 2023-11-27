import { ethers, toNumber } from "ethers";
const {
  abi: QuoterV2ABI,
} = require("@uniswap/swap-router-contracts/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
const {
  abi: PoolABI,
} = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const {
  abi: FactoryABI,
} = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

import { TickMath, SwapMath, TickListDataProvider, Tick, FeeAmount, LiquidityMath } from "@uniswap/v3-sdk";
import JSBI from 'jsbi';
import TickLensABI from "./contracts/ticklens.json";
 

import { QUOTER2_ADDRESS, FACTORY_ADDRESS, TICKLENS_ADDRESS } from "./config/info";

interface QuoteExactInputSingleParams {
  tokenIn: ethers.Contract;
  tokenOut: ethers.Contract;
  fee: bigint;
  amountIn: bigint;
  poolAddress: string;
  provider: ethers.Provider;
}

interface QuoteExactOutputSingleParams {
  tokenIn: ethers.Contract;
  tokenOut: ethers.Contract;
  fee: bigint;
  amountOut: bigint;
  poolAddress: string;
  provider: ethers.Provider;
}

interface SwapState {
  amountSpecifiedRemain: JSBI,
  amountCalculated: JSBI,
  sqrtPriceX96: JSBI,
  tick: number,
  liquidity: JSBI
}

/**
 *
 * @param tokenIn Address of token to be swapped
 * @param tokenOut Address of token to be received
 * @param fee Fee tier of the pool
 * @param provider Ethers provider
 * @returns
 */
export async function getPoolAddress(
  tokenIn: string,
  tokenOut: string,
  fee: ethers.BigNumberish,
  provider: ethers.Provider
): Promise<any> {
  const factoryContract = new ethers.Contract(
    FACTORY_ADDRESS,
    FactoryABI,
    provider
  );

  const poolAddress = await factoryContract.getPool(tokenIn, tokenOut, fee);
  return poolAddress;
}

function Q96toPrice(q96: bigint, decimals0: bigint, decimals1: bigint): number {
  let mathPrice = Number(q96) ** 2 / 2 ** 192;
  const decimalAdjustment = 10 ** (Number(decimals0) - Number(decimals1));
  const price = mathPrice * decimalAdjustment;
  return price;
}

async function quoteExactInputSingle(data: QuoteExactInputSingleParams) {
  // Instantiate the QuoterV2 contract for quoting swap information
  const quoterContract = new ethers.Contract(
    QUOTER2_ADDRESS,
    QuoterV2ABI,
    data.provider
  );

  const params = {
    tokenIn: data.tokenIn.target,
    tokenOut: data.tokenOut.target,
    fee: data.fee,
    amountIn: data.amountIn,
    sqrtPriceLimitX96: "0",
  };

  const quote = await quoterContract.quoteExactInputSingle.staticCall(params);
  return { retVal: quote.amountOut, sqrtPriceAfter: Number(quote[1]) };
}

async function quoteExactOutputSingle(data: QuoteExactOutputSingleParams) {
  // Instantiate the QuoterV2 contract for quoting swap information
  const quoterContract = new ethers.Contract(
    QUOTER2_ADDRESS,
    QuoterV2ABI,
    data.provider
  );

  const params = {
    tokenIn: data.tokenIn.target,
    tokenOut: data.tokenOut.target,
    fee: data.fee,
    amount: data.amountOut,
    sqrtPriceLimitX96: 0,
  };

  const quote = await quoterContract.quoteExactOutputSingle.staticCall(params);

  return { retVal: quote.amountIn, sqrtPriceAfter: Number(quote[1]) };
}

/**
 * Calculates the price impact of a token swap in a given Uniswap v3 pool.
 *
 * @param tokenInContract Ethers contract of the token to be swapped.
 * @param tokenOutContract Ethers contract of the token to be received.
 * @param fee Fee tier of the pool.
 * @param amountIn Amount of tokenIn to be swapped.
 * @param poolAddress Address of the Uniswap v3 pool.
 * @param provider Ethers provider for interacting with the Ethereum network.
 * @returns An object containing the price before and after the swap Price for 1 tokenIn in tokenOut.
 */
export async function getPriceImpactBySwap(
  tokenInContract: ethers.Contract,
  tokenOutContract: ethers.Contract,
  fee: bigint,
  amountIn: string,
  victimAmntIn: string,
  minVictimAmntOut: string,
  poolAddress: string,
  provider: ethers.Provider
) {
  
  const decimalsIn = await tokenInContract.decimals();
  const decimalsOut = await tokenOutContract.decimals();

  const deltaX_AB = ethers.parseUnits(amountIn, decimalsIn);
  const deltaX_BC = ethers.parseUnits(victimAmntIn, decimalsIn);
 
  let params: QuoteExactInputSingleParams = {
      tokenIn: tokenInContract,
      tokenOut: tokenOutContract,
      fee,
      amountIn: deltaX_AB,
      poolAddress,
      provider,
    };

    // swappingEstimator(poolAddress, provider, BigInt(amountIn), 0);

  // Amount out if we swap only our amtIn
  const raw = await quoteExactInputSingle(params);
  const deltaY_AB = raw.retVal;
  console.log(
    `Amount out if we swap only our amtIn ${amountIn}: `,
    ethers.formatUnits(deltaY_AB, decimalsOut)
  );

  const deltaX_AC = deltaX_AB + deltaX_BC;
  params.amountIn = deltaX_AC;
  // Amount out if we swap with our amtIn and victimAmntIn
  const raw2 = await quoteExactInputSingle(params);
  const deltaY_AC = raw2.retVal;
  console.log(
    `Amount out if we swap with our amtIn and victimAmntIn ${
      Number(victimAmntIn) + Number(amountIn)
    }: `,
    ethers.formatUnits(deltaY_AC, decimalsOut)
  );

  // Amount out if victim swaps only their amtIn AFTER our swap
  const deltaY_BC = deltaY_AC - deltaY_AB;
  console.log(
    `Amount out if victim swaps only their amtIn ${Number(
      victimAmntIn
    )} AFTER our swap: `,
    ethers.formatUnits(deltaY_BC, decimalsOut)
  );
  // todo this might not work since parseUnits can be a bigint
  if (deltaY_BC < ethers.parseUnits(minVictimAmntOut, decimalsOut)) {
    console.log(
      "Amount out for victim is less than minVictimAmntOut, abort attack"
    );
    return;
  }

  const deltaY_AD = deltaY_BC;
  const rawSell = await quoteExactOutputSingle({
    ...params,
    amountOut: BigInt(deltaY_AD),
  });

  const deltaX_AD = rawSell.retVal;

  const deltaX_CD = deltaX_AC - deltaX_AD;
  console.log(
    `We will get ${ethers.formatUnits(
      deltaX_CD,
      decimalsIn
    )} tokenIn back after we swap ${ethers.formatUnits(
      deltaY_AB,
      decimalsOut
    )} out `
  );


  const sqrtPriceX96AfterBuys = raw2.sqrtPriceAfter;

  const tst = await swappingEstimator(poolAddress, provider, deltaX_AB, sqrtPriceX96AfterBuys);
  console.log(`$a0: ${tst.amount0}, a1: ${tst.amount1}`);
}

export async function swappingEstimator(poolAddress: string, provider: ethers.Provider, sellAmt: bigint, sqrtPriceX96: number) {
  const poolContract = new ethers.Contract(
    poolAddress,
    PoolABI,
    provider
  );
  const lensContract = new ethers.Contract(
    TICKLENS_ADDRESS,
    TickLensABI,
    provider
  );
  const slot0 = await poolContract.slot0();
  const rawTicks = await lensContract.getPopulatedTicksInWord(poolAddress, 1);
  const allTicks: Tick[] = [];

  // rawTicks is returned in reverse sort, need to sort and format it
  for (let i = rawTicks.length - 1; i >= 0; i--) {
    let f = rawTicks[i];
    allTicks.push(
      {
        index: Number(f[0]),
        liquidityGross: JSBI.BigInt(Number(f[2])),
        liquidityNet: JSBI.BigInt(Number(f[1]))
      });
  }

  const startSqrtPricex96 = JSBI.BigInt(sqrtPriceX96);
  let sellTick = TickMath.getTickAtSqrtRatio(JSBI.BigInt(startSqrtPricex96));
  const currTick = slot0.tick;
  const tickSpace = Number(await poolContract.tickSpacing()); // directly correlates to fee

  const tickProvider = new TickListDataProvider(allTicks, tickSpace);

  let liquidity = await poolContract.liquidity();
  console.log(currTick);
  // move the current tick to the target tick (to start selling at)
  while (sellTick !== currTick) {
    let lte = sellTick <= currTick; // left or right
    let [ tickNext, initialied ] = await tickProvider.nextInitializedTickWithinOneWord(sellTick, lte, tickSpace);
    if (tickNext < TickMath.MIN_TICK) {
      tickNext = TickMath.MIN_TICK;
    } else if (tickNext > TickMath.MAX_TICK) {
        tickNext = TickMath.MAX_TICK;
    }
    
    if (initialied) {
      // move liquidity to sellTick
      const tickData = await tickProvider.getTick(tickNext);
      liquidity = LiquidityMath.addDelta(liquidity, JSBI.BigInt(tickData.liquidityNet));
    }
    sellTick = lte ? tickNext - 1 : tickNext;
    console.log(sellTick)
  }

  const zeroForOne = false;// todo check errors here
  const sellAmtJSBI = JSBI.BigInt(Number(sellAmt));
  let state: SwapState = {
    amountSpecifiedRemain: sellAmtJSBI,
    amountCalculated: JSBI.BigInt(0),
    sqrtPriceX96: startSqrtPricex96,
    tick: sellTick,
    liquidity
  };

  // This also should have the price limit (but we dont have one)
  while (JSBI.greaterThan(state.amountSpecifiedRemain, JSBI.BigInt(0))) {

    let [ tickNext, initialied ] = await tickProvider.nextInitializedTickWithinOneWord(state.tick, zeroForOne, tickSpace);

    if (tickNext < TickMath.MIN_TICK) {
      tickNext = TickMath.MIN_TICK;
    } else if (tickNext > TickMath.MAX_TICK) {
        tickNext = TickMath.MAX_TICK;
    }

    const stepSqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(tickNext);

    //TODO FEE??
    const [ statePrice, stepAmntin, stepAmntOut, stepFeeAmnt ] = SwapMath.computeSwapStep(startSqrtPricex96, stepSqrtPriceNextX96, state.liquidity, state.amountSpecifiedRemain, tickSpace as FeeAmount);
    state.sqrtPriceX96 = statePrice;

    state.amountSpecifiedRemain = JSBI.subtract(state.amountSpecifiedRemain, (JSBI.ADD(stepAmntin, stepFeeAmnt)));
    state.amountCalculated = JSBI.subtract(state.amountCalculated, stepAmntOut); // todo check subtract direction

    if (JSBI.equal(state.sqrtPriceX96, stepSqrtPriceNextX96)) {
      // reached next price, need to shift tick
      if (initialied) {
        const tickData = await tickProvider.getTick(tickNext);
        const liquidityNet = zeroForOne ? -tickData.liquidityNet : tickData.liquidityNet;
        state.liquidity = LiquidityMath.addDelta(JSBI.BigInt(state.liquidity), JSBI.BigInt(liquidityNet));

        state.tick = zeroForOne ? tickNext - 1 : tickNext;
      }
    }
    else if (JSBI.equal(state.sqrtPriceX96, startSqrtPricex96)) {
      state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96); 
    }
  }


  let amount0 = JSBI.subtract(sellAmtJSBI, state.amountSpecifiedRemain);
  let amount1 = state.amountCalculated;

  if (!zeroForOne) {
    [amount1, amount0] = [amount0, amount1];
  }

  return {
    amount0, amount1
  };
}