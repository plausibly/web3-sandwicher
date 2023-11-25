import { ethers, toNumber } from "ethers";

interface QuoteParams {
  tokenIn: ethers.Contract;
  tokenOut: ethers.Contract;
  fee: bigint;
  amountIn: bigint;
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

async function getQuote(data: QuoteParams) {
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

  const quoteB = await quoterContract.quoteExactInputSingle.staticCall(params);
  let retVal;
  if (isInputToken0) {
    retVal = ethers.formatUnits(quoteB.amountOut, decimals1);
  } else {
    retVal = ethers.formatUnits(quoteB.amountOut, decimals0);
  }
  return Number(retVal);
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
  amountIn: bigint,
  victimAmnt: bigint,
  minVictimAmntOut: bigint,
  poolAddress: string,
  provider: ethers.Provider
) {
  let params: QuoteParams = {
    tokenIn: tokenInContract,
    tokenOut: tokenOutContract,
    fee,
    amountIn,
    poolAddress,
    provider,
  };

  // Amount out if we swap only our amtIn
  const quoteA = await getQuote(params);
  console.log("Amount out if we swap only our amtIn", quoteA);

  params.amountIn += victimAmnt;
  // Amount out if we swap with our amtIn and victimAmntIn
  const quoteB = await getQuote(params);
  console.log("Amount out if we swap with our amtIn and victimAmntIn", quoteB);

  // Amount out if victim swaps only their amtIn AFTER our swap
  const diff = quoteB - quoteA;
  console.log("Amount out if victim swaps only their amtIn AFTER our swap", diff);

  if(diff < minVictimAmntOut) {
    console.log("Amount out for victim is less than minVictimAmntOut, abort attack"); 
    return;
  }
}
