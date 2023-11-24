import { ethers, toNumber } from "ethers";
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
  fee: ethers.BigNumberish,
  amountIn: ethers.BigNumberish,
  poolAddress: string,
  provider: ethers.Provider
): Promise<any> {
  // Instantiate the QuoterV2 contract for quoting swap information
  const quoterContract = new ethers.Contract(
    QUOTER2_ADDRESS,
    QuoterV2ABI,
    provider
  );
  
  // Instantiate the Uniswap v3 pool contract
  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);

  // Retrieve the current sqrtPriceX96 from the Uniswap v3 pool
  const slot0 = await poolContract.slot0();
  const currentSqrtPriceX96 = slot0.sqrtPriceX96;
  
  // Determine which token is token0 and get its decimals
  const token0 = await poolContract.token0();
  const isInputToken0 = token0 === tokenInContract.target;

  const decimals0 = isInputToken0
    ? await tokenInContract.decimals()
    : await tokenOutContract.decimals();
  const decimals1 = isInputToken0
    ? await tokenOutContract.decimals()
    : await tokenInContract.decimals();

    const params = {
    tokenIn: tokenInContract.target,
    tokenOut: tokenOutContract.target,
    fee,
    amountIn,
    sqrtPriceLimitX96: "0",
  };

  // Simulate the swap to get the post-swap sqrtPriceX96
  const quote = await quoterContract.quoteExactInputSingle.staticCall(params);
    const sqrtPriceX96AfterSwap = quote.sqrtPriceX96After;

  // Convert the current and post-swap prices from Q96 to a human-readable format
  let currentPrice = Q96toPrice(currentSqrtPriceX96, decimals0, decimals1);
    let priceAfterSwap = Q96toPrice(sqrtPriceX96AfterSwap, decimals0, decimals1);

  // Adjust prices if the input token is not token0
  if (!isInputToken0) {
        currentPrice = 1 / currentPrice;
    priceAfterSwap = 1 / priceAfterSwap;
  }

  // Return the prices before and after the swap
  return { priceBeforeSwap: currentPrice, priceAfterSwap: priceAfterSwap };
}
