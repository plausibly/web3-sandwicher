import "dotenv/config";
import { Web3 } from "web3";
import { UNISWAPROUTER, WETH_ADDRESS, AUC_ADDRESS, NETWORK } from "./config/info";
import { ethers } from "ethers";
import UniversalRouter from "./contracts/UniversalRouter.json";
import WETH_ABI from "./contracts/weth.json";
import AUC_ABI from "./contracts/erc20.json";
import { getPoolAddress, getPriceImpactBySwap } from "./calc";

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

// testPriceImpact("0.01", "0", BigInt(10000));
listenTransactions();

