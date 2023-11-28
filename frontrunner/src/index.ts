import "dotenv/config";
import { Web3 } from "web3";
import { UNISWAPROUTER, WETH_ADDRESS, AUC_ADDRESS, NETWORK } from "./config/info";
import { ethers, hexlify } from "ethers";
import UniversalRouter from "./contracts/UniversalRouter.json";
import WETH_ABI from "./contracts/weth.json";
import AUC_ABI from "./contracts/erc20.json";
import { getPoolAddress, getPriceImpactBySwap, swappingEstimator } from "./calc";
import { encodeRouteToPath } from "@uniswap/v3-sdk";
import { hexToBytes } from "ethereum-cryptography/utils";

/* V3_SWAP_EXACT_IN Transaction. */
interface UniswapInfo_SwapIn {
  recipient: string; // recipient of the trade (NOT always the transaction sender)
  amountIn: bigint; // will need to be formatted into decimals based on token type
  amountOutMin: bigint;
  path: string[]; // contains the token contracts being swapped
  fees: bigint[];
  payerIsUser: boolean;
}

/* V3_SWAP_EXACT_OUT Transaction. */
interface UniswapInfo_SwapOut {
  recipient: string;
  amountOut: BigInt;
  amountInMax: BigInt;
  path: string[];
  fees: BigInt[];
  payerIsUser: boolean;
}

interface CandidateTx {
  txFrom: string;
  txGas: string;
  txHash: string; // transaction hash containing the data
  swapInfo: UniswapInfo_SwapIn;
  deadline: bigint;
}

const ROUTER_RECIPIENT = "0x0000000000000000000000000000000000000002";
const SENDER_RECIPIENT = "0x0000000000000000000000000000000000000001";

const web3 = new Web3(process.env.ALCHEMY_WS_URL);
const routerAbi = new ethers.Interface(UniversalRouter);
const attackBudgetIn = "0.01";

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

  console.log(commands);
  console.log(inputs);
  console.log(deadline);

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

  console.log(decoded[3]);

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
  if (recipient === ROUTER_RECIPIENT) {
    recipient = UNISWAPROUTER.toLocaleLowerCase();
  } else if (recipient === SENDER_RECIPIENT) {
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

/**
 * Encodes a transaction for the UniversalRouter contract.
 * @param swapInfo Swap information to encode.
 * @param deadline Deadline for the transaction.
 * @returns Encoded transaction.
 * @throws Error if the swap information is invalid.
 * @throws Error if the deadline is invalid.
 */
function encodeData(swapInfo: UniswapInfo_SwapIn | UniswapInfo_SwapOut, deadline: bigint) {
    const abiEncode = new ethers.AbiCoder();

    if (swapInfo.path.length !== 2) {
      return;
    }
    const isSwapin = 'amountIn' in swapInfo;
    const commands = "0x000c"; //TODO change
    
    // fee must be 0-padded base 16
    let feeInHex = swapInfo.fees[0].toString(16);
    feeInHex = "0".repeat(6 - feeInHex.length) + feeInHex;

    // Only need "0x" at the start. Remove from last address
    let path = `${swapInfo.path[0]}${feeInHex}${swapInfo.path[1].substring(2)}`;
    if (!isSwapin) {
      path = `${swapInfo.path[1]}${feeInHex}${swapInfo.path[0].substring(2)}`;
    }

    // recipient is a constant based on the contract
    const recipientMap = swapInfo.recipient.toLowerCase() === UNISWAPROUTER.toLowerCase() ? ROUTER_RECIPIENT : SENDER_RECIPIENT;

    let dataToEncode = [];
    if (isSwapin) {
        dataToEncode = [recipientMap, swapInfo.amountIn, swapInfo.amountOutMin, path, swapInfo.payerIsUser]
        
    } else {
        dataToEncode = [recipientMap, swapInfo.amountOut, swapInfo.amountInMax, path, swapInfo.payerIsUser];
    }

    const encode = [abiEncode.encode(["address", "uint256", "uint256", "bytes", "bool"], dataToEncode)];

    return {
      commands, // TODO this is 0x0{.. what??}
      inputs: encode,
      deadline,
    }
}

async function listenTransactions() {
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
        if (uniswapInfo) {
          console.log(uniswapInfo);
          const p = await testPriceImpact(uniswapInfo.swapInfo);
          if (p && p > 0) {
            console.log(p);
          }
        }
      }
    } catch (err) {}
  });
}

async function testPriceImpact(swapInfo: UniswapInfo_SwapIn) {
  const victimAmntIn = swapInfo.amountIn;
  const minVictimAmntOut = swapInfo.amountOutMin;
  const fee = swapInfo.fees[0];

  const provider = new ethers.AlchemyProvider(
    NETWORK,
    process.env.ALCHEMY_API_KEY
  );
  const WETH_CONTRACT = new ethers.Contract(WETH_ADDRESS, WETH_ABI, provider);
  const AUC_CONTRACT = new ethers.Contract(AUC_ADDRESS, AUC_ABI, provider);

  if (swapInfo.path[0].toLowerCase() !== WETH_ADDRESS.toLowerCase() || swapInfo.path[1].toLowerCase() !== AUC_ADDRESS.toLowerCase()) {
    return BigInt(0);
  }

  const poolAddress = await getPoolAddress(
    WETH_ADDRESS,
    AUC_ADDRESS,
    fee,
    provider
  );

  const priceImpact = await getPriceImpactBySwap(
    WETH_CONTRACT,
    AUC_CONTRACT,
    fee,
    attackBudgetIn,
    ethers.formatUnits(victimAmntIn),
    ethers.formatUnits(minVictimAmntOut),
    poolAddress,
    provider
  );

  return priceImpact;
}

function decodeTest(commands: string, inputs: string[], deadline: any) {
  const V3_SWAP_EXACT_IN = "00";

  const abiDecode = new ethers.AbiCoder();
  const input = inputs[commands.substring(2).indexOf(V3_SWAP_EXACT_IN) / 2];

  // see Dispatcher.sol
  const decoded = abiDecode.decode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    input
  );

  console.log(decoded[3]);

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

  const swapInfo: UniswapInfo_SwapIn = {
    recipient,
    amountIn: decoded[1],
    amountOutMin: decoded[2],
    path,
    payerIsUser: decoded[4],
    fees: fees,
  };
  
  return {
    swapInfo: swapInfo,
    deadline: deadline,
  };
}

const txTst = {
  txFrom: '0xaf9e2959a7520aad5fe059ed4bcb7ae831e9d6b0',
  txGas: BigInt(179728),
  txHash: '0xf9ca6b6f382e4329f22399ba2e89017993dc4f84473780d19915213b5c511b17',
  swapInfo: {
    recipient: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
    amountIn: BigInt(10000000000000),
    amountOutMin: BigInt(34398207),
    path: [
      '0xedb2ae3da8a443cf90f67539a886f69c85bd5d69',
      '0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6'
    ],
    payerIsUser: true,
    fees: [ BigInt(10000) ]
  },
  deadline: BigInt(1701197952)
}

const tst = encodeData(txTst.swapInfo, txTst.deadline);
console.log(tst);
if (tst)
console.log(decodeTest(tst?.commands, tst?.inputs, tst?.deadline));



// testPriceImpact({amountIn: BigInt(1000000000000000), amountOutMin: BigInt(10), fees: [BigInt(10000)], path: [WETH_ADDRESS, AUC_ADDRESS]} as any as UniswapInfo_SwapIn);
listenTransactions();

// swappingEstimator()
