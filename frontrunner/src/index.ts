import "dotenv/config";
import { Web3 } from "web3";
import {
  UNISWAPROUTER,
  WETH_ADDRESS,
  AUC_ADDRESS,
  NETWORK,
  TICKLENS_ADDRESS,
} from "./config/info";
import { ethers } from "ethers";
import UniversalRouter from "./contracts/UniversalRouter.json";
import WETH_ABI from "./contracts/weth.json";
import ERC20_ABI from "./contracts/erc20.json";
import {
  getPoolAddress,
  getPriceImpactBySwap,
  swappingEstimator,
} from "./calc";
import { ChainId, Token } from "@uniswap/sdk-core";
// import { simulateAttack } from "./SwapManager";
import { FeeAmount } from "@uniswap/v3-sdk";
import { simulateAttack, buildTradeParams, fetchAllTicks } from "./SwapManager";
const {
  abi: PoolABI,
} = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");


/* V3_SWAP_EXACT_IN Transaction. */
interface UniswapInfo_SwapIn {
  recipient: string; // recipient of the trade (NOT always the transaction sender)
  amountIn: bigint; // will need to be formatted into decimals based on token type
  amountOutMin: bigint;
  path: string[]; // contains the token contracts being swapped
  fees: bigint[];
  payerIsUser: boolean;
}

interface CandidateTx {
  txFrom: string;
  txGas: string;
  txHash: string; // transaction hash containing the data
  swapInfo: UniswapInfo_SwapIn;
  deadline: bigint;
}

const web3 = new Web3(process.env.ALCHEMY_WS_URL);
const routerAbi = new ethers.Interface(UniversalRouter);
const attackBudgetIn = ethers.parseEther("0.04");
const provider = new ethers.AlchemyProvider(
  NETWORK,
  process.env.ALCHEMY_API_KEY
);
let FR_LOCK = false;

const tokenInAddr = WETH_ADDRESS;

/**
 * Decodes function call into the UniversalRouter contract and outputs human readable object
 * containing swap details.
 **/
function decodeData(
  data: string,
  value: bigint,
  from: string,
  hash: string,
  txgas: string
): CandidateTx | undefined {
  // Taken from router contract
  const V3_SWAP_EXACT_IN = "00";
  // const V3_SWAP_EXACT_OUT = "01";

  const parsed = routerAbi.parseTransaction({ data, value });
  if (!parsed || parsed.name !== "execute" || parsed.args.length !== 3) {
    return;
  }

  // args: commands, inputs, deadline
  const commands: string = parsed.args[0];
  const inputs: string[] = parsed.args[1];
  const deadline: bigint = parsed.args[2];
  // const isSwapOut = commands.includes(V3_SWAP_EXACT_OUT);

  if (!commands.includes(V3_SWAP_EXACT_IN)) {
    // only care if tx is for a swap in
    return;
  }

  const abiDecode = new ethers.AbiCoder();
  const input = inputs[commands.substring(2).indexOf(V3_SWAP_EXACT_IN) / 2];

  // see Dispatcher.sol
  const decoded = abiDecode.decode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    input
  );

  // Decode path (tokens being swapped)
  const rawPath = decoded[3].substring(2);
  let path = [];
  let fees = [];
  // <addr1><fee><addr2>...
  let i = 0;
  while (i < rawPath.length) {
    path.push(`0x${rawPath.slice(i, i + 40)}`);
    i += 40;

    if (i + 6 < rawPath.length) {
      fees.push(BigInt(`0x${rawPath.slice(i, i + 6)}`));
      i += 6;
    }

    if (path.length > 2) {
      return; // only care about token a <-> b conversion
    }
  }

  // recipient is a constant defined in Constants.sol (universalrouter github)
  let recipient = decoded[0];
  if (recipient === "0x0000000000000000000000000000000000000002") {
    recipient = UNISWAPROUTER.toLocaleLowerCase();
  } else if (recipient === "0x0000000000000000000000000000000000000001") {
    recipient = from;
  }

  const swapInfo: UniswapInfo_SwapIn = {
    recipient,
    amountIn: decoded[1],
    amountOutMin: decoded[2],
    path,
    payerIsUser: decoded[4],
    fees: fees,
  };

  return {
    txFrom: from,
    txGas: txgas,
    txHash: hash,
    swapInfo: swapInfo,
    deadline: deadline,
  };
}

async function listenTransactions(
  callback: (swapInfo: UniswapInfo_SwapIn) => void
) {
  const subscription = await web3.eth.subscribe(
    "pendingTransactions",
    (err: any, res: any) => {
      if (!err) {
        console.log(res);
      }
    }
  );

  subscription.on("data", async (tx) => {
    try {
      const rawTxData = await web3.eth.getTransaction(tx);
      if (
        rawTxData.to &&
        rawTxData.to.toLowerCase() === UNISWAPROUTER.toLowerCase()
      ) {
        const uniswapInfo = decodeData(
          rawTxData.input,
          BigInt(rawTxData.value),
          rawTxData.from,
          tx,
          rawTxData.gas
        );
        const path = uniswapInfo?.swapInfo?.path;
        if (uniswapInfo && path && path[0] === tokenInAddr.toLowerCase()) {
          // console.log("Found a swap in transaction: ", uniswapInfo);
          callback(uniswapInfo?.swapInfo);
        }
      }
    } catch (err) {}
  });
}

async function frontRun(swapInfo: UniswapInfo_SwapIn) {
  const poolAddress = await getPoolAddress(
    swapInfo.path[0],
    swapInfo.path[1],
    swapInfo.fees[0],
    provider
  );

  console.log(poolAddress)
  const poolContract = new ethers.Contract(
    poolAddress,
    PoolABI,
    provider
  );
  
  const totalGas = 0;
  console.log("Frontrun executed ");
  let profit = Number(await checkProfitability(swapInfo, poolContract)); // 14121212312 -> 1.1
  console.log(`Raw returned porfit: ${profit}`)
  profit = profit - totalGas;
  console.log("Total gas: ", totalGas);
  console.log("Profit: ", profit);
  if (profit > 0) {
    console.log("This is profitable: ", profit);
    if (FR_LOCK) {
      console.log("Front run already in progress, aborting attack");
    }
    FR_LOCK = true;
    console.log("Front running attack initiated");
    // free lock after we confirm that we received our profit
    FR_LOCK = false;
    console.log("Front running attack completed");
  }
}

async function checkProfitability(swapInfo: UniswapInfo_SwapIn, poolContract: ethers.Contract) {
  const addressTokenA = swapInfo.path[0].toLowerCase();
  const addressTokenB = swapInfo.path[1].toLowerCase();
  const victimAmntIn = swapInfo.amountIn;
  const minVictimAmntOut = swapInfo.amountOutMin;
  const fee = Number(swapInfo.fees[0]) as FeeAmount;

  // TODO SUPPORT OTHER POOLS. CAN WE USE IERC-20 TO JUST GET DECIMLS()?
  const ContractTokenA = new ethers.Contract(addressTokenA, ERC20_ABI, provider);
  const ContractTokenB = new ethers.Contract(addressTokenB, ERC20_ABI, provider);

  const tokenA = new Token(ChainId.GOERLI, addressTokenA, Number(await ContractTokenA.decimals()));
  const tokenB = new Token(ChainId.GOERLI, addressTokenB, Number(await ContractTokenB.decimals()));
 
  const retVal = await simulateAttack(poolContract, tokenA, tokenB, fee, attackBudgetIn, victimAmntIn, minVictimAmntOut);

  return retVal;
}

async function executeSwap(poolContract: ethers.Contract, recipient: string, tokenA: Token, tokenB: Token, amountIn: string, amountOut: string, fee: FeeAmount) {
  const txParam = await buildTradeParams(poolContract, tokenA, tokenB, fee, amountIn, amountOut, recipient);

  console.log(txParam);
  // TODO: Approve transfers
  // TODO: Build

}

async function main() {
  console.log("Listening for transactions");
  await listenTransactions(frontRun);
    // const addressTokenA = WETH_ADDRESS;
    // const addressTokenB = AUC_ADDRESS;
    // const victimAmntIn = ethers.parseEther("0.0005");
    // const minVictimAmntOut = ethers.parseEther("0.01");
    // const fee = FeeAmount.HIGH;

    // // TODO SUPPORT OTHER POOLS. CAN WE USE IERC-20 TO JUST GET DECIMLS()?
    // const ContractTokenA = new ethers.Contract(addressTokenA, ERC20_ABI, provider);
    // const ContractTokenB = new ethers.Contract(addressTokenB, ERC20_ABI, provider);


    // const poolAddress = await getPoolAddress(
    //   addressTokenA,
    //   addressTokenB,
    //   fee,
    //   provider
    // );
  
    // const poolContract = new ethers.Contract(
    //   poolAddress,
    //   PoolABI,
    //   provider
    // );  

    // const tokenA = new Token(ChainId.GOERLI, addressTokenA, Number(await ContractTokenA.decimals()));
    // const tokenB = new Token(ChainId.GOERLI, addressTokenB, Number(await ContractTokenB.decimals()));
 
    // const retVal = await simulateAttack(poolContract, tokenA, tokenB, fee, attackBudgetIn, victimAmntIn, minVictimAmntOut);
}

main();
