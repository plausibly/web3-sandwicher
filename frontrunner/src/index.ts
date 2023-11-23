import "dotenv/config";
import { Web3 } from 'web3';
import { UNISWAPROUTER } from "./config/info";
import { ethers } from "ethers";
import UniversalRouter from "./contracts/UniversalRouter.json"

interface UniswapInfo {
    recipient: string, // recipient of the trade (NOT always the transaction sender)
    amountIn: BigInt, // will need to be formatted into decimals based on token type
    amountOutMin: BigInt,
    path: string[], // contains the token contracts being swapped
    payerIsUser: boolean,
}

interface CandidateTx {
    txFrom: string,
    txGas: string,
    txHash: string, // transaction hash containing the data
    swapInfo: UniswapInfo,
    deadline: BigInt
}

const web3 = new Web3(process.env.ALCHEMY_WS_URL);
const routerAbi = new ethers.Interface(UniversalRouter);

function decodeData(data: string, value: bigint, from: string, hash: string, txgas: string) {
    // Taken from router contract
    const V3_SWAP_EXACT_IN = "00";
    const V3_SWAP_EXACT_OUT = "01"
    
    const parsed = routerAbi.parseTransaction({ data, value });
    if (!parsed || parsed.name !== "execute") {
        return;
    }

     if (parsed.args.length !== 3) {
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
    const fullPathWithoutHexSymbol = decoded[3].substring(2);
    let path = [];
    let currentAddress = "";
    for (let i = 0; i < fullPathWithoutHexSymbol.length; i++) {
        currentAddress += fullPathWithoutHexSymbol[i];
        if (currentAddress.length === 40) {
            path.push('0x' + currentAddress);
            i = i + 6;
            currentAddress = "";
        }
    }
    path = !isSwapOut ? path : path.reverse();


    // recipient is a constant defined in Constants.sol (universalrouter github)
    let recipient = decoded[0];
    if (recipient === "0x0000000000000000000000000000000000000002") {
        recipient = UNISWAPROUTER.toLocaleLowerCase();
    } else if (recipient === "0x0000000000000000000000000000000000000001") {
        recipient = from;
    }

    const swapData: CandidateTx = {
        txFrom: from,
        txGas: txgas,
        txHash: hash,
        swapInfo: {
            recipient,
            amountIn: decoded[1],
            amountOutMin: decoded[2],
            path,
            payerIsUser: decoded[4],
        },
        deadline: deadline, 
    }
    return swapData;
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