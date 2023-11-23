import { ethers } from "ethers";
const {
  abi: QuoterV2ABI,
} = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");
const {
  abi: PoolABI,
} = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
const {
  abi: FactoryABI,
} = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

const QUOTER2_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

/**
 *
 * @param tokenIn Address of token to be swapped
 * @param tokenOut Address of token to be received
 * @param fee Fee tier of the pool
 * @param provider Ethers provider
 * @returns
 */
async function getPoolAddress(
  tokenIn: string,
  tokenOut: string,
  fee: number,
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

function Q96toPrice(q96: number, decimals0: number, decimals1: number): number {
  const numerator = q96 ** 2;
  const denominator = 2 ** 96;
  const decimalsToShift = Math.pow(10, decimals0 - decimals1);
  let ratio = (numerator / denominator) * decimalsToShift;
  return ratio;
}

/**
 *
 * @param tokenInContract Ethers contract of token to be swapped
 * @param tokenOutContract Ethers contract of token to be received
 * @param fee Fee tier of the pool
 * @param poolAddress Address of the pool
 * @param amountIn Amount of tokenIn to be swapped
 */
async function getPriceImpactBySwap(
  tokenInContract: ethers.Contract,
  tokenOutContract: ethers.Contract,
  fee: number,
  amountIn: number,
  poolAddress: string,
  provider: ethers.Provider
): Promise<any> {
  const factoryContract = new ethers.Contract(
    FACTORY_ADDRESS,
    FactoryABI,
    provider
  );

  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);
  const slot0 = await poolContract.slot0();
  const currentSqrtPriceX96 = slot0.sqrtPriceX96;

  const token0 = await poolContract.token0();

  const isInputToken0 = token0 === tokenInContract.target;

  const decimals0 = isInputToken0
    ? await tokenInContract.decimals()
    : await tokenOutContract.decimals();
  const decimals1 = isInputToken0
    ? await tokenOutContract.decimals()
    : await tokenInContract.decimals();

  const quoterContract = new ethers.Contract(
    QUOTER2_ADDRESS,
    QuoterV2ABI,
    provider
  );
  const quote = await quoterContract.quoteExactInputSingle.staticCall(
    tokenInContract.target,
    tokenOutContract.target,
    fee,
    amountIn,
    0
  );
  const sqrtPriceX96AfterSwap = quote.sqrtPriceX96After;

  let currentPrice = Q96toPrice(currentSqrtPriceX96, decimals0, decimals1);

  let priceAfterSwap = Q96toPrice(
    sqrtPriceX96AfterSwap,
    decimals0,
    decimals1
  );
  if (!isInputToken0) {
    currentPrice = 1 / currentPrice;
    priceAfterSwap = 1 / priceAfterSwap;
  }
  
  return {priceBeforeSwap: currentPrice, priceAfterSwap: priceAfterSwap};
}
