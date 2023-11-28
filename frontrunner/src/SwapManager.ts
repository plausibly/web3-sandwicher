import "dotenv/config";
import { Pool, nearestUsableTick, TickMath, FeeAmount, TICK_SPACINGS} from "@uniswap/v3-sdk";
import { ChainId, CurrencyAmount, Ether, Token } from "@uniswap/sdk-core"
import { ethers } from "ethers";
import { AUC_ADDRESS, NETWORK, WETH_ADDRESS } from "./config/info";
const {
    abi: PoolABI,
  } = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
import JSBI from "jsbi";

export async function getPoolObject(poolContract: ethers.Contract, tokenA: Token, tokenB: Token, fee: FeeAmount) {
    const slot0 = await poolContract.slot0();
    const liquidity = JSBI.BigInt((await poolContract.liquidity()).toString());
    const sqrtPriceX96 = JSBI.BigInt(slot0.sqrtPriceX96.toString());

    console.log(slot0.tick);

    return new Pool(tokenA, tokenB, fee, sqrtPriceX96, liquidity, Number(slot0.tick), [
        {
            index: nearestUsableTick(TickMath.MIN_TICK, TICK_SPACINGS[fee]),
            liquidityNet: liquidity,
            liquidityGross: liquidity,
        },
        {
            index: nearestUsableTick(TickMath.MAX_TICK, TICK_SPACINGS[fee]),
            liquidityNet: JSBI.multiply(liquidity, JSBI.BigInt('-1')),
            liquidityGross: liquidity,
        },
    ]);
}

async function main() {
    const provider = new ethers.AlchemyProvider(
        NETWORK,
        process.env.ALCHEMY_API_KEY
    );
    

    const poolContract = new ethers.Contract(
        "0xC8D37F70e244C91fA06A4BBc07ca9ca31AFd91c0",
        PoolABI,
        provider
    );
    
    const tokenA = new Token(ChainId.GOERLI, WETH_ADDRESS, 18);
    const tokenB = new Token(ChainId.GOERLI, AUC_ADDRESS, 18);
    const fee = FeeAmount.HIGH;
    
    let poolSim = await getPoolObject(poolContract, tokenA, tokenB, fee);

    // Buying tokenB with provided tokenA
    const attackerInput = ethers.parseEther("0.001").toString();
    const victimInput = ethers.parseEther("0.0005").toString();
    
    const attackerBuyFormat = CurrencyAmount.fromRawAmount(tokenA, attackerInput);
    const victimBuyFormat = CurrencyAmount.fromRawAmount(tokenA, victimInput);

    let result = await poolSim.getOutputAmount(attackerBuyFormat);
    const attackerPurchasedAmount = result[0];
    // change pool state after the first buy
    poolSim = result[1];

    result = await poolSim.getOutputAmount(victimBuyFormat);
    const victimPurchasedAmount = result[0];
    poolSim = result[1];

    // How much tokenA if attacker sell tokenB
    result = await poolSim.getOutputAmount(attackerPurchasedAmount);
    const attackerSoldAmount = result[0];
    poolSim = result[1];

    console.log(`Attacker buys ${attackerPurchasedAmount.toExact()} with ${attackerBuyFormat.toExact()} ETH `)
    console.log(`Victim buys ${victimPurchasedAmount.toExact()} with ${victimBuyFormat.toExact()} ETH `)
    console.log(`Attacker sells ${attackerPurchasedAmount.toExact()} for ${attackerSoldAmount.toExact()} ETH`)

}

main();



