import { ethers } from "ethers";

export const NETWORK = "goerli";
export const UNISWAPROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

export const TICKLENS_ADDRESS = "0xbfd8137f7d1516d3ea5ca83523914859ec47f573";
export const QUOTER2_ADDRESS = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
export const FACTORY_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
export const AUC_ADDRESS = "0xedB2AE3DA8A443Cf90f67539A886f69c85BD5d69";
export const WETH_ADDRESS = "0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6";

export const provider = new ethers.AlchemyProvider(
    NETWORK,
    process.env.ALCHEMY_API_KEY
  );