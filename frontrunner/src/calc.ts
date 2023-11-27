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

import { TickMath, SwapMath, TickListDataProvider, Tick, FeeAmount } from "@uniswap/v3-sdk";
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

  // Instantiate the Uniswap v3 pool contract
  const poolContract = new ethers.Contract(
    data.poolAddress,
    PoolABI,
    data.provider
  );

  // Determine which token is token0 and get its decimals
  const token0 = await poolContract.token0();

  // const isInputToken0 = token0 === data.tokenIn.target;

  const params = {
    tokenIn: data.tokenIn.target,
    tokenOut: data.tokenOut.target,
    fee: data.fee,
    amountIn: data.amountIn,
    sqrtPriceLimitX96: "0",
  };

  const quote = await quoterContract.quoteExactInputSingle.staticCall(params);
  let retVal = quote.amountOut;
  // if (!isInputToken0) {
  //   retVal = retVal;
  // }

  return { retVal, ticksCrossed: quote[2], sqrtPriceAfter: Number(quote[1])};
}

async function quoteExactOutputSingle(data: QuoteExactOutputSingleParams) {
  // Instantiate the QuoterV2 contract for quoting swap information
  const quoterContract = new ethers.Contract(
    QUOTER2_ADDRESS,
    QuoterV2ABI,
    data.provider
  );

  // Instantiate the Uniswap v3 pool contract
  const poolContract = new ethers.Contract(
    data.poolAddress,
    PoolABI,
    data.provider
  );

  // Determine which token is token0 and get its decimals
  const token0 = await poolContract.token0();

  const isInputToken0 = token0 === data.tokenIn.target;

  const params = {
    tokenIn: data.tokenIn.target,
    tokenOut: data.tokenOut.target,
    fee: data.fee,
    amount: data.amountOut,
    sqrtPriceLimitX96: 0,
  };

  const quoteB = await quoterContract.quoteExactOutputSingle.staticCall(params);
  let retVal = quoteB.amountIn;
  if (!isInputToken0) {
    retVal = BigInt(1) / retVal;
  }
  return retVal;
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


  // todo cleanup code
 // swappingEstimator(poolAddress, provider, deltaX_AB, raw2.sqrtPriceAfter);
 

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
  console.log(poolAddress)
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

  const currSqrtPricex96 = JSBI.BigInt(sqrtPriceX96);
  let currTick = TickMath.getTickAtSqrtRatio(JSBI.BigInt(currSqrtPricex96));
  const tickSpace = Number(await poolContract.tickSpacing());

  const tickProvider = new TickListDataProvider(allTicks, tickSpace);

  // Given sellAmt and the "current" tick, compute

  let amntRemain = sellAmt;
  const liquidity = 0; // ????

  //TODO cehck zeroforone
  const fee = JSBI.BigInt(Number(await poolContract.feeGrowthGlobal0X128()));

  while (amntRemain > 0) {
    let amntCalculated = 0;
    let [ tickNext, initialied ] = await tickProvider.nextInitializedTickWithinOneWord(currTick, true, tickSpace);

    if (tickNext < TickMath.MIN_TICK) {
      tickNext = TickMath.MIN_TICK;
    } else if (tickNext > TickMath.MAX_TICK) {
        tickNext = TickMath.MAX_TICK;
    }

    const sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(tickNext);

    //TODO FEE??
    const [ stateSqrtPricex96, stepAmntin, stepAmntOut, stepFeeAmnt ] = SwapMath.computeSwapStep(currSqrtPricex96, sqrtPriceNextX96, liquidity, JSBI.BigInt(Number(amntRemain)), FeeAmount.LOW);

    amntRemain -= (JSBI.ADD(stepAmntin, stepFeeAmnt));


  }

  
}