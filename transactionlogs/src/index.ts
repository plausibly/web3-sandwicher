import "dotenv/config";
import { abi as PoolABI } from "@uniswap/v3-core/artifacts/contracts//UniswapV3Pool.sol/UniswapV3Pool.json";
import { abi as FactoryABI } from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import { UNISWAPROUTER, WETH_ADDRESS, AUC_ADDRESS, FACTORY_ADDRESS } from "./config/info";
import { EventLog, ethers } from "ethers";
import WETH_ABI from "./contracts/WETH.json";
import AUC_ABI from "./contracts/erc20.json";

interface track_data {
  txHash: string;
  recipient: string;
  token: bigint[];
}

const provider = new ethers.AlchemyProvider(
  "goerli",
  process.env.ALCHEMY_API_KEY
);
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

async function findAllSandwichAttacks() {
  const poolAddress = await getPoolAddress(
    WETH_ADDRESS,
    AUC_ADDRESS,
    10000,
    provider
  );

  // const tokenAddress = await Promise.all([poolContract.token0(), poolContract.token1()]);
  // console.log(tokenAddress);
  const WETH_CONTRACT = new ethers.Contract(WETH_ADDRESS, WETH_ABI, provider);
  const AUC_CONTRACT = new ethers.Contract(AUC_ADDRESS, AUC_ABI, provider);
  const tokenName = await Promise.all([WETH_CONTRACT.symbol(), AUC_CONTRACT.symbol()]);

  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);

  // poolContract.on("*", (event) => {
  //   console.log(event);
  //   console.log(event.log);
  // });

  const events = await poolContract.queryFilter("*");
  
  let track: track_data[] = [];
  events.forEach(async (event) => {
    const argues = (event as EventLog).args;
    if (argues.length === 7 && argues[1] !== UNISWAPROUTER) {
      const i = track.length;
      track[i] = { txHash: event.transactionHash, recipient: argues[1], token: [argues[2], argues[3]] };
      if (i === 1) {
        if (argues[1] !== track[0].recipient) {
          if (track[0].token[1] > 0 !== track[1].token[1] > 0) {
            track.shift();
          }
        } else {
          track.shift();
        }
      }
      if (i === 2) {
        if (argues[1] == track[0].recipient) {
          const buyId = track[0].token[0] >= 0 ? 1 : 0;
          const payId = track[2].token[0] <= 0 ? 1 : 0;
          const gainAmount = -(track[2].token[1-payId] + track[0].token[1-buyId]);
          const diff = track[0].token[buyId] + track[2].token[payId];
          const diffBit = (track[0].token[buyId].toString().length + track[2].token[buyId].toString().length)/2 - diff.toString().length;
          if (buyId === payId &&
              gainAmount > 0 &&
              diffBit > 3) {
            console.log(track);
            console.log({
              buyer: track[1].recipient,
              attacker: track[0].recipient,
              token: tokenName[1-buyId],
              gainAmount,
            });
            console.log('------------------------------------');
            track = [];
          } else {
            track.shift();
            track.shift();
          }
        } else {
          track.shift();
          track.shift();
        }
      }
    }
    
  });
}

findAllSandwichAttacks();
