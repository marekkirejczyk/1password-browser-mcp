---
name: wallet-test
description: Unlock a dedicated TEST crypto wallet extension (MetaMask, Rabby) from 1Password through the 1password-browser-mcp server and drive a dapp through connect / sign / approve flows on a testnet. Use for wallet or dapp QA. Arguments: <1Password item title> [dapp URL]. Refuses wallets whose item title does not start with "TEST".
---

# Wallet test flow

You are driving a browser through the `browser_*` and `onepassword_*` tools of the
1password-browser-mcp server. The wallet you unlock is a throwaway test wallet whose password
lives in 1Password; the password never passes through you.

## Guard rails (check before anything else)

1. The 1Password item named in `$ARGUMENTS` must have a title starting with `TEST` (case
   insensitive). Verify with `onepassword_items query=<title>`. If it does not, stop and say the
   skill only handles test wallets.
2. Only testnets. Before signing or approving anything, read the network shown in the wallet
   or the dapp; if it is a mainnet (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, ...),
   stop and report instead of approving.
3. Never export, display, or copy seed phrases or private keys, even if a page offers them.

## Wallet extension pages

| wallet   | extension id                       | unlock page                                                   |
|----------|------------------------------------|---------------------------------------------------------------|
| MetaMask | `nkbihfbeogaeaoehlefnkodbefgpgknn` | `chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/home.html` |
| Rabby    | `acmacodkjbdgmoleebolmdjonilkdbch` | `chrome-extension://acmacodkjbdgmoleebolmdjonilkdbch/index.html` |

Pick the wallet from the item title (contains "metamask" or "rabby") unless the user says which.

## Steps

1. `browser_status` to make sure the server is attached and the extension profile is loaded.
2. `browser_navigate url=<unlock page> snapshot=true`. If the snapshot shows the wallet is already
   unlocked (accounts, balances, no password box), skip to step 5.
3. `onepassword_fill strategy=cli item="<title>" submit=true`. On wallet pages only the CLI
   strategy works (the 1Password extension does not run inside other extensions' pages). If the
   result says `password: empty`, report the error text verbatim and stop.
4. `browser_snapshot` and confirm the unlock succeeded (no "Unlock" button, account visible).
   If a wrong-password message appears, stop; do not retry with other items.
5. If a dapp URL was given: `browser_navigate url=<dapp>`; take a snapshot, find and click the
   connect-wallet control, choose the wallet when asked.
6. Wallet prompts open as extra tabs named `chrome-extension://<id>/notification.html...`.
   After each dapp action run `browser_tabs action=list`, `browser_tabs action=select index=<n>`
   on the notification tab, snapshot it, read what it asks (connect, switch network, sign message,
   send transaction), apply the guard rails, then click Next / Connect / Confirm / Sign or Reject.
   Switch back to the dapp tab afterwards.
7. Report: wallet and network, each prompt seen and how it was answered, the dapp's final state,
   and anything unexpected (console errors via `browser_console onlyErrors=true` if useful).

## Setting up the test wallet (one time, done by the user)

- Preferably create a separate browser profile for testing (Chrome: profile menu > Add; Brave:
  Settings > Profiles) and install the wallet extension and 1Password there. Point the server at it
  with `BROWSER_MCP_BROWSER=chrome BROWSER_MCP_PROFILE="Profile 2"` (name from `chrome://version`).
- In the wallet, create a brand-new wallet with a fresh seed. Never import a funded one.
- Save the password (and, if you want, the seed) as a 1Password item titled e.g. `TEST MetaMask`
  in the Login, Password, or Crypto Wallet category; the server searches all three.
- Fund it only from testnet faucets.
