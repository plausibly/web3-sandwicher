import "dotenv/config";
import { Web3 } from 'web3';
import { UNISWAPROUTER } from "./config/info";
import { ethers } from "ethers";
import UniversalRouter from "./contracts/UniversalRouter.json"
  
/* V3_SWAP_EXACT_IN Transaction. */
interface UniswapInfo_SwapIn {
    recipient: string, // recipient of the trade (NOT always the transaction sender)
    amountIn: BigInt, // will need to be formatted into decimals based on token type
    amountOutMin: BigInt,
    path: string[], // contains the token contracts being swapped
    fees: BigInt[],
    payerIsUser: boolean,
}

/* V3_SWAP_EXACT_OUT Transaction. */
interface UniswapInfo_SwapOut {
    recipient: string,
    amountOut: BigInt,
    amountInMax: BigInt,
    path: string[],
    fees: BigInt[],
    payerIsUser: boolean,
}

interface CandidateTx {
    txFrom: string,
    txGas: string,
    txHash: string, // transaction hash containing the data
    swapInfo: UniswapInfo_SwapIn | UniswapInfo_SwapOut,
    deadline: BigInt
}

const web3 = new Web3(process.env.ALCHEMY_WS_URL);
const routerAbi = new ethers.Interface(UniversalRouter);

/**
 * Decodes function call into the UniversalRouter contract and outputs human readable object
 * containing swap details.
 **/
function decodeData(data: string, value: bigint, from: string, hash: string, txgas: string) {
    // Taken from router contract
    const V3_SWAP_EXACT_IN = "00";
    const V3_SWAP_EXACT_OUT = "01"
    
    const parsed = routerAbi.parseTransaction({ data, value });
    if (!parsed || parsed.name !== "execute" || parsed.args.length !== 3) {
        return;
    }

    // args: commands, inputs, deadline
    const commands: string = parsed.args[0];
    const inputs: string[] = parsed.args[1];
    const deadline: BigInt = parsed.args[2];
    const isSwapOut = commands.includes(V3_SWAP_EXACT_OUT);

    if (!commands.includes(V3_SWAP_EXACT_IN) && !isSwapOut) {
        // only care if tx is for a swap in
        return;
    }

    const abiDecode = new ethers.AbiCoder();
    const input = inputs[commands.substring(2).indexOf(V3_SWAP_EXACT_IN) / 2];

    // see Dispatcher.sol
    const decoded = abiDecode.decode(["address", "uint256", "uint256", "bytes", "bool"], input);

    // Decode path (tokens being swapped)
    // https://ethereum.stackexchange.com/questions/144478/uniswap-universal-router-decoding-the-execute-function-parameters
    const rawPath = decoded[3].substring(2);
    let path = [];
    let fees = [];
    let currentAddress = "";
    // <addr1><fees><addr2>...
    for (let i = 0; i < rawPath.length; i++) {
        currentAddress += rawPath[i];
        if (currentAddress.length === 40) {
            path.push("0x" + currentAddress);
            if (i+1 < rawPath.length && i+6 < rawPath.length) {
                fees.push(BigInt("0x" + rawPath.slice(i+1, i+7)));
            }
            i += 6; // skip fees bytes to only get token addresses
            currentAddress = "";
        }
    }
    path = !isSwapOut ? path : path.reverse();
    fees = !isSwapOut ? fees : fees.reverse();


    // recipient is a constant defined in Constants.sol (universalrouter github)
    let recipient = decoded[0];
    if (recipient === "0x0000000000000000000000000000000000000002") {
        recipient = UNISWAPROUTER.toLocaleLowerCase();
    } else if (recipient === "0x0000000000000000000000000000000000000001") {
        recipient = from;
    }

    let swapInfo: UniswapInfo_SwapIn | UniswapInfo_SwapOut;
    console.log("Raw path " + decoded[3]);
    if (!isSwapOut) {
       swapInfo = {
            recipient,
            amountIn: decoded[1],
            amountOutMin: decoded[2],
            path,
            payerIsUser: decoded[4],
            fees: fees,
        }
    } else {
        swapInfo = {
            recipient,
            amountOut: decoded[1],
            amountInMax: decoded[2],
            path,
            payerIsUser: decoded[4],
            fees: fees
        }
    }

    return {
        txFrom: from,
        txGas: txgas,
        txHash: hash,
        swapInfo: swapInfo,
        deadline: deadline, 
    };
}

async function listenTransactions() {
    const subscription = await web3.eth.subscribe("pendingTransactions", (err: any, res: any) => {
        if (!err) {
            console.log(res);
        }
    });

    subscription.on("data", async (tx) => {
        try {
            const rawTxData = await web3.eth.getTransaction(tx);
            if (rawTxData.to && rawTxData.to.toLowerCase() === UNISWAPROUTER.toLowerCase()) {
                const uniswapInfo = decodeData(rawTxData.input, BigInt(rawTxData.value), rawTxData.from, tx, rawTxData.gas);
                if (uniswapInfo) {
                    console.log(uniswapInfo);
                }
            }
        } catch (err) {}
    });
}

listenTransactions();