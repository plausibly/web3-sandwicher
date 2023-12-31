import "dotenv/config";
import { Web3 } from "web3";
import { AUC_ADDRESS, UNISWAPROUTER, WETH_ADDRESS } from "./config/info";
import { ethers } from "ethers";
import { provider } from "./config/info";
import UniversalRouter from "./contracts/UniversalRouter.json";
import ERC20_ABI from "./contracts/erc20.json";
import { getPoolAddress } from "./calc";
import { ChainId, Token } from "@uniswap/sdk-core";
// import { simulateAttack } from "./SwapManager";
import { FeeAmount } from "@uniswap/v3-sdk";
import {
  simulateAttack,
  buildTradeParams,
  clearLoadedTicks,
} from "./SwapManager";
import { abi as PoolABI } from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json";

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
0;
const attackBudgetUnformat = "0.0001";
const attackBudgetIn = ethers.parseEther(attackBudgetUnformat);

let FR_LOCK = false;

const tokenInAddr = WETH_ADDRESS;
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY as string, provider);

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

async function listenTransactions(callback: (txData: CandidateTx) => void) {
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
        const fees = uniswapInfo?.swapInfo?.fees;
        if (
          uniswapInfo &&
          path &&
          path[0] === tokenInAddr.toLowerCase() &&
          fees
        ) {
          if (!FR_LOCK) {
            FR_LOCK = true;
            console.log("Checking transaction: ", uniswapInfo.txHash);
            callback(uniswapInfo);
          }
        }
      }
    } catch (err) {}
  });
}

async function frontRun(txData: CandidateTx) {
  const swapInfo = txData.swapInfo;
  const addressTokenA = swapInfo.path[0].toLowerCase();
  const addressTokenB = swapInfo.path[1].toLowerCase();
  const poolAddress = await getPoolAddress(
    addressTokenA,
    addressTokenB,
    swapInfo.fees[0],
    provider
  );

  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);

  const ContractTokenA = new ethers.Contract(
    addressTokenA,
    ERC20_ABI,
    provider
  );
  const ContractTokenB = new ethers.Contract(
    addressTokenB,
    ERC20_ABI,
    provider
  );

  const tokenA = new Token(
    ChainId.GOERLI,
    addressTokenA,
    Number(await ContractTokenA.decimals())
  );
  const tokenB = new Token(
    ChainId.GOERLI,
    addressTokenB,
    Number(await ContractTokenB.decimals())
  );

  const victimTxData = await provider.getTransaction(txData.txHash);
  const victimGasPrice = victimTxData?.gasPrice;
  const victimGasLimit = victimTxData?.gasLimit;

  const ourBuyGasPrice = BigInt(Math.floor(Number(victimGasPrice) * 2));
  const ourBuyGasLimit = BigInt(Math.floor(Number(victimGasLimit) * 2));

  const ourSellGasPrice = BigInt(Math.floor(Number(victimGasPrice) * 0.5));
  const ourSellLimit = BigInt(Math.floor(Number(victimGasLimit) * 0.5));

  const totalGas = 0;
  const profitData = await checkProfitability(
    swapInfo,
    poolContract,
    tokenA,
    tokenB
  );
  let profit = Number(profitData.profit);

  // how much token B we need to sell
  let amntToSell = Number(profitData.sellAmount);

  console.log(`Raw returned profit: ${profit}`);
  profit = profit - totalGas;
  console.log("Total gas: ", totalGas);
  console.log("Profit: ", profit);
  if (profit > 0) {
    console.log("This is profitable: ", profit);

    // try {
    //   console.log("Front running attack initiated");
    //   const feeAmnt = Number(swapInfo.fees[0]) as FeeAmount;
    //   // Buy tokenB with TokenA (ETH)
    //   const receiptBuy = await executeSwap(
    //     poolContract,
    //     tokenA,
    //     tokenB,
    //     attackBudgetUnformat,
    //     feeAmnt,
    //     true,
    //     ourBuyGasPrice,
    //     ourBuyGasLimit
    //   );
    //   console.log("Sent buy transaction", receiptBuy.hash);
    //   // wait for victim (how?)
    //   await receiptBuy.wait();

    //   const receiptSell = await executeSwap(
    //     poolContract,
    //     tokenA,
    //     tokenB,
    //     amntToSell.toString(),
    //     feeAmnt,
    //     false,
    //     ourSellGasPrice,
    //     ourSellLimit
    //   );
    //   console.log("Sent sell transaction", receiptSell.hash);
    //   console.log("Front running attack completed");
    // } catch (e) {
    //   console.error(e);
    // }

  }
  FR_LOCK = false;

  return;
}

async function checkProfitability(
  swapInfo: UniswapInfo_SwapIn,
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token
) {
  clearLoadedTicks();
  const victimAmntIn = swapInfo.amountIn;
  const minVictimAmntOut = swapInfo.amountOutMin;
  const fee = Number(swapInfo.fees[0]) as FeeAmount;

  console.log(`Checking profitability on a potential transaction`);

  const retVal = await simulateAttack(
    poolContract,
    tokenA,
    tokenB,
    fee,
    attackBudgetIn,
    victimAmntIn,
    minVictimAmntOut
  );

  return retVal;
}

/**
 * Execute a swap given the parameters.
 * @param poolContract
 * @param recipient
 * @param tokenA primary token in pool (ETH)
 * @param tokenB secondary token
 * @param amountIn This should be in non-gwei format. I.e 1 to represent 1 ETH
 * @param fee pool fee
 * @param aForB If true, swaps token A -> token B.
 * @returns
 */
async function executeSwap(
  poolContract: ethers.Contract,
  tokenA: Token,
  tokenB: Token,
  amountIn: string,
  fee: FeeAmount,
  aForB: boolean,
  gasPrice?: bigint,
  gasLimit?: bigint
) {
  // aforB = true => input token a and get token b
  const tokenSpend = aForB ? tokenA : tokenB;
  console.log(`Spend: ${tokenSpend.address}`);
  const tokenSpentContract = new ethers.Contract(
    tokenSpend.address,
    ERC20_ABI,
    wallet
  );
  const amntFormat = ethers.parseUnits(amountIn, tokenSpend.decimals);

  const txParam = await buildTradeParams(
    poolContract,
    tokenSpend,
    tokenSpend !== tokenA ? tokenA : tokenB,
    fee,
    amntFormat.toString(),
    process.env.WALLET_ADDRESS as string
  );

  if (!aForB) console.log(`Approving send of ${amountIn}`);
  const approval = await tokenSpentContract.approve(UNISWAPROUTER, amntFormat);
  await approval.wait();

  console.log("Submitting transaction");
  const txObj = {
    data: txParam.calldata,
    to: UNISWAPROUTER,
    value: txParam.value,
  } as any;
  if (gasPrice) {
    txObj["gasPrice"] = gasPrice;
  }
  if (gasLimit) {
    txObj["gasLimit"] = gasLimit;
  }
  const tx = await wallet.sendTransaction(txObj);
  // const receipt = await tx.wait();
  return tx;
}

async function main() {
  console.log(`Approving all weth spending`);
  const tokenSpentContract = new ethers.Contract(
    WETH_ADDRESS,
    ERC20_ABI,
    wallet
  );
  const approval = await tokenSpentContract.approve(
    UNISWAPROUTER,
    "115792089237316195423570985008687907853269984665640564039457584007913129639935"
  );
  await approval.wait();

  console.log("Listening for transactions");
  await listenTransactions(frontRun);
  // const addressTokenA = WETH_ADDRESS;
  // const addressTokenB = AUC_ADDRESS;
  // const victimAmntIn = ethers.parseEther("0.0005");
  // const minVictimAmntOut = ethers.parseEther("0.01");
  // const fee = FeeAmount.HIGH;

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
  // // // const recipient = "0xaF9e2959a7520aaD5fe059ED4bcb7ae831e9d6B0";
  // const ok = await executeSwap(poolContract, tokenA, tokenB, "0.001", FeeAmount.HIGH, true);

  // console.log(ok);
  // // // console.log(ok)
  // const retVal = await simulateAttack(poolContract, tokenA, tokenB, fee, attackBudgetIn, victimAmntIn, minVictimAmntOut);
}
//0.33648
// main();

async function demo() {
  const weth_contract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider);
  const auc_contract = new ethers.Contract(AUC_ADDRESS, ERC20_ABI, provider);
  const weth_decimals = await weth_contract.decimals();
  const auc_decimals = await auc_contract.decimals();
  const fee = 10000;
  const feeAmount = Number(fee) as FeeAmount;
  const poolAddress = await getPoolAddress(
    WETH_ADDRESS,
    AUC_ADDRESS,
    fee,
    provider
  );

  const poolContract = new ethers.Contract(poolAddress, PoolABI, provider);
  const attackBudgetUnformat = "0.0001";
  const attackBudgetIn = ethers.parseEther(attackBudgetUnformat);
  const victimAmntIn = ethers.parseUnits("0.001", weth_decimals);
  const minVictimAmntOut = ethers.parseUnits("0", auc_decimals);

  const WETH_token = new Token(
    ChainId.GOERLI,
    WETH_ADDRESS,
    Number(weth_decimals)
  );
  const AUC_Token = new Token(
    ChainId.GOERLI,
    AUC_ADDRESS,
    Number(auc_decimals)
  );

  const retVal = await simulateAttack(
    poolContract,
    WETH_token,
    AUC_Token,
    feeAmount,
    attackBudgetIn,
    victimAmntIn,
    minVictimAmntOut
  );
  console.log(`Raw returned profit: ${retVal.profit}`);
}

// demo();
main();
