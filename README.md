
# Sandwich

The POC for sandwich attack and related logic can be found in `frontrunner/`

Required .env variables

ALCHEMY_API_KEY=<ALCHEMY API>
PRIVATE_KEY=<WALLET PRIVATE>
WALLET_ADDRESS=<WALLET ADDRESS>

Run with `npx ts-node src/index.ts` to scan tx prices, only filters for V3 swaps in. 

Quoting / Swap logic / tx builder (disabled) in `SwapManager`
Listener / Tx sender (disabled) in `index.ts`

Old implementation in `calc.ts`

# Transaction Logs

The transaction logs for frontrunning detection can be found in `transactionlogs/`

Similarly, requires ALCHEMY_API.

Run with `npx ts-node src/index.ts`

By default will scan WETH->AUC_ADDRESS pool. Addresses and fee can be changed to scan other pools in `findAllSandwichAttacks`