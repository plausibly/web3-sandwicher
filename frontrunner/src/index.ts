import "dotenv/config";
import { Web3 } from "web3";
import {
  UNISWAPROUTER,
  WETH_ADDRESS,
  AUC_ADDRESS,
  NETWORK,
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
import { getNextTick, simulateAttack, buildTradeParams } from "./SwapManager";
import { parse } from "dotenv";

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
const attackBudgetIn = "0.01";
const provider = new ethers.AlchemyProvider(
  NETWORK,
  process.env.ALCHEMY_API_KEY
);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY as string, provider);

let FR_LOCK = false;

const tokenInAddr = WETH_ADDRESS;
let tokenOutAddr = "";
const tokenInABI = WETH_ABI;
const tokenOutABI = ERC20_ABI;
const tokenInContract = new ethers.Contract(tokenInAddr, tokenInABI, provider);
let tokenOutContract: ethers.Contract;
let fee: bigint;
let poolAddress: string;
let decimalsIn: bigint;
let decimalsOut: bigint;

async function init() {
  decimalsIn = await tokenInContract.decimals();
}

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
        if (uniswapInfo?.swapInfo) {
          console.log(uniswapInfo?.swapInfo);
        }
        if (path && path[0] === tokenInAddr.toLowerCase()) {
          console.log("Found a swap in transaction: ", uniswapInfo);
          callback(uniswapInfo?.swapInfo);
        }
      }
    } catch (err) {}
  });
}

async function frontRun(swapInfo: UniswapInfo_SwapIn) {
  fee = swapInfo?.fees[0];

  const path = swapInfo.path;
  tokenOutAddr = path[1];
  tokenOutContract = new ethers.Contract(tokenOutAddr, tokenOutABI, provider);
  decimalsOut = await tokenOutContract.decimals();
  poolAddress = await getPoolAddress(tokenInAddr, tokenOutAddr, fee, provider);

  //   const totalFee = (Number(fee) / 1000000) * (Number(attackBudgetIn) * 2);
  const totalFee = 0;
  const totalGas = 0;
  let profit = await testPriceImpact(swapInfo);
  profit =
    Number(ethers.formatUnits(profit, decimalsIn)) - (totalFee + totalGas);
  console.log("Total fee: ", totalFee);
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

async function testPriceImpact(swapInfo: UniswapInfo_SwapIn) {
  const victimAmntIn = swapInfo.amountIn;
  const minVictimAmntOut = swapInfo.amountOutMin;

  const priceImpact = await getPriceImpactBySwap(
    tokenInContract,
    tokenOutContract,
    decimalsIn,
    decimalsOut,
    fee,
    attackBudgetIn,
    ethers.formatUnits(victimAmntIn, decimalsIn),
    ethers.formatUnits(minVictimAmntOut, decimalsOut),
    poolAddress,
    provider
  );

  return priceImpact;
}

// testPriceImpact({amountIn: BigInt(1000000000000000), amountOutMin: BigInt(10), fees: [BigInt(10000)], path: [WETH_ADDRESS, AUC_ADDRESS]} as any as UniswapInfo_SwapIn);
// listenTransactions(frontRun);

// swappingEstimator()

async function sendTx(transaction: any) {
  const tx = await wallet.sendTransaction(transaction);
  const receipt = await tx.wait();
  console.log(receipt);
}

async function main() {
  fee = BigInt(10000);
  tokenOutAddr = AUC_ADDRESS;
  tokenOutContract = new ethers.Contract(tokenOutAddr, tokenOutABI, wallet);
  decimalsOut = await tokenOutContract.decimals();
  poolAddress = await getPoolAddress(tokenInAddr, tokenOutAddr, fee, provider);
  decimalsIn = await tokenInContract.decimals();
  decimalsOut = await tokenOutContract.decimals();
  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);
  const tokenA = new Token(ChainId.GOERLI, tokenInAddr, Number(decimalsIn));
  const tokenB = new Token(ChainId.GOERLI, tokenOutAddr, Number(decimalsOut));
  const fees = Number(10000) as FeeAmount;

  const methodParameters = await buildTradeParams(
    poolContract,
    tokenB,
    tokenA,
    fees,
    ethers.parseUnits("100", decimalsOut).toString(),
    ethers.parseUnits("0.0339928", decimalsIn).toString(),
    process.env.WALLET_ADDRESS as string
  );
    console.log(methodParameters)
  const x = decodeData(
    methodParameters.calldata,
    BigInt(methodParameters.value),
    process.env.WALLET_ADDRESS as string,
    "",
    "0"
  );
  console.log(x);
  // //approve 100 auc to router
  // const approval = await tokenOutContract.approve(
  //   UNISWAPROUTER,
  //   ethers.parseUnits("100", decimalsOut)
  // );
  // const receipt = await approval.wait();
  // console.log(receipt);
  // // Define the gas price and limit
  // const gasPrice = ethers.parseUnits("30", "gwei"); // Replace with your desired gas price
  // const gasLimit = 24000; // Replace with your desired gas limit

  // const tx = {
  //   data: methodParameters.calldata,
  //   to: UNISWAPROUTER,
  //   value: methodParameters.value,
  //   gasPrice: gasPrice,
  //   gasLimit: gasLimit,
  // };
  // await sendTx(tx);
  // await init();
  // await listenTransactions(frontRun);
}

main();
