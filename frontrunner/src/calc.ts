import { ethers, toNumber } from "ethers";

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

const {
  abi: QuoterV2ABI,
} = require("@uniswap/swap-router-contracts/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
const {
  abi: PoolABI,
} = require("@uniswap/v3-core/artifacts/contracts//UniswapV3Pool.sol/UniswapV3Pool.json");
const {
  abi: FactoryABI,
} = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

import { QUOTER2_ADDRESS, FACTORY_ADDRESS } from "./config/info";

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

  const isInputToken0 = token0 === data.tokenIn.target;

  const decimals0 = isInputToken0
    ? await data.tokenIn.decimals()
    : await data.tokenOut.decimals();
  const decimals1 = isInputToken0
    ? await data.tokenOut.decimals()
    : await data.tokenIn.decimals();

  const params = {
    tokenIn: data.tokenIn.target,
    tokenOut: data.tokenOut.target,
    fee: data.fee,
    amountIn: data.amountIn,
    sqrtPriceLimitX96: "0",
  };

  const quote = await quoterContract.quoteExactInputSingle.staticCall(params);
  let retVal = quote.amountOut;
  if (!isInputToken0) {
    retVal = 1 / retVal;
  }
  return retVal;
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

  const decimals0 = isInputToken0
    ? await data.tokenIn.decimals()
    : await data.tokenOut.decimals();
  const decimals1 = isInputToken0
    ? await data.tokenOut.decimals()
    : await data.tokenIn.decimals();

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
    retVal = 1 / retVal;
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
  const deltaY_AB = await quoteExactInputSingle(params);
  console.log(
    `Amount out if we swap only our amtIn ${amountIn}: `,
    ethers.formatUnits(deltaY_AB, decimalsOut)
  );

  const test = await quoteExactOutputSingle({
    ...params,
    amountOut: deltaY_AB,
  });

  console.log(
    `Amount we need in if we expect ${ethers.formatUnits(
      deltaY_AB,
      decimalsOut
    )} out: `,
    ethers.formatUnits(test, decimalsIn)
  );
  const deltaX_AC = deltaX_AB + deltaX_BC;
  params.amountIn = deltaX_AC;
  // Amount out if we swap with our amtIn and victimAmntIn
  const deltaY_AC = await quoteExactInputSingle(params);
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

  if (deltaY_BC < ethers.parseUnits(minVictimAmntOut, decimalsOut)) {
    console.log(
      "Amount out for victim is less than minVictimAmntOut, abort attack"
    );
    return;
  }

  const deltaY_AD = deltaY_BC;
  const deltaX_AD = await quoteExactOutputSingle({
    ...params,
    amountOut: BigInt(deltaY_AD),
  });

  const deltaX_CD = deltaX_AC - deltaX_AD;
  console.log(
    `We will get ${ethers.formatUnits(
      deltaX_CD,
      decimalsIn
    )} tokenIn back after we swap ${ethers.formatUnits(
      deltaY_AC,
      decimalsOut
    )} out `
  );
}
