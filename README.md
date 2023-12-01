
# Sandwich

The POC for sandwich attack and related logic can be found in `frontrunner/`

This uses Georli testnet since Uniswap does not have all their smart contracts deployed on Sepolia (i.e Ticklens).

Required .env variables

```
ALCHEMY_API_KEY=<ALCHEMY API>

PRIVATE_KEY=<WALLET PRIVATE>

WALLET_ADDRESS=<WALLET ADDRESS>
```

Run with `npx ts-node src/index.ts` to scan buys and predict prices. This will only scan for V3 buy transactions on pools that take WETH/ETH as input.

There is also a transaction builder based on the predicted prices, however this code is commented out.

Code structure: Quoting / Swap logic / tx builder (disabled) in `SwapManager`

Listener, tx sender (disabled) in `index.ts`

Old implementation in `calc.ts`

# Transaction Logs

The transaction logs for frontrunning detection can be found in `transactionlogs/`

Similarly, requires ALCHEMY_API.

Run with `npx ts-node src/index.ts`

By default will scan WETH->AUC_ADDRESS pool. Addresses and fee can be changed to scan other pools in `findAllSandwichAttacks()`