import { ethers } from "ethers";

/** Aave v4 Ethereum mainnet, Main Spoke. Calls are planned here and signed in the vault. */
export const AAVE_MAIN_SPOKE = "0x94e7A5dCbE816e498b89aB752661904E2F56c485";
export const AAVE_CORE_HUB = "0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9";
const ETH_RPC = "https://ethereum.publicnode.com";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const MIN_SAFE_WAD = 15n * 10n ** 17n;
const LIMIT_USE_BPS = 9_000n;
const FULL_REPAY_BUFFER_BPS = 10_005n;
const GAS_RESERVE_UNITS = 600_000n;
const GAS_RESERVE_FLOOR = 3_000_000_000_000_000n;

export const AAVE_RESERVES = [
  { id: 0, symbol: "WETH", underlying: ETH_WETH, decimals: 18, collateral: true, borrow: true },
  { id: 1, symbol: "wstETH", underlying: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", decimals: 18, collateral: true, borrow: false },
  { id: 2, symbol: "weETH", underlying: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", decimals: 18, collateral: true, borrow: false },
  { id: 3, symbol: "WBTC", underlying: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, collateral: true, borrow: true },
  { id: 4, symbol: "cbBTC", underlying: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, collateral: true, borrow: true },
  { id: 7, symbol: "USDC", underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, collateral: true, borrow: true },
  { id: 8, symbol: "USDT", underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, collateral: true, borrow: true },
  { id: 9, symbol: "EURC", underlying: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", decimals: 6, collateral: false, borrow: true },
  { id: 10, symbol: "RLUSD", underlying: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD", decimals: 18, collateral: false, borrow: true },
  { id: 11, symbol: "USDG", underlying: "0xe343167631d89B6Ffc58B88d6b7fB0228795491D", decimals: 6, collateral: false, borrow: true },
  { id: 12, symbol: "frxUSD", underlying: "0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29", decimals: 18, collateral: false, borrow: true },
  { id: 13, symbol: "GHO", underlying: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", decimals: 18, collateral: false, borrow: true },
];

const SPOKE_ABI = [
  "function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)",
  "function ORACLE() view returns (address)",
  "function getReserve(uint256 reserveId) view returns (tuple(address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey))",
  "function getReserveConfig(uint256 reserveId) view returns (tuple(uint24 collateralRisk, bool paused, bool frozen, bool borrowable, bool receiveSharesEnabled))",
  "function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey) view returns (tuple(uint16 collateralFactor, uint32 maxLiquidationBonus, uint16 liquidationFee))",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)",
  "function getUserPosition(uint256 reserveId, address user) view returns (tuple(uint120 drawnShares, uint120 premiumShares, int200 premiumOffsetRay, uint120 suppliedShares, uint32 dynamicConfigKey))",
  "function getUserAccountData(address user) view returns (tuple(uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))",
];
const HUB_ABI = [
  "function getSpoke(uint256 assetId, address spoke) view returns (tuple(uint120 drawnShares, uint120 premiumShares, int200 premiumOffsetRay, uint120 addedShares, uint40 addCap, uint40 drawCap, uint24 riskPremiumThreshold, bool active, bool halted, uint200 deficitRay))",
  "function getSpokeAddedAssets(uint256 assetId, address spoke) view returns (uint256)",
  "function getSpokeTotalOwed(uint256 assetId, address spoke) view returns (uint256)",
  "function getAssetLiquidity(uint256 assetId) view returns (uint256)",
  "function getAssetDrawnRate(uint256 assetId) view returns (uint256)",
  "function MAX_ALLOWED_SPOKE_CAP() view returns (uint40)",
];
const ORACLE_ABI = [
  "function decimals() view returns (uint8)",
  "function getReservePrice(uint256 reserveId) view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256)",
];
const WETH_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad)",
];

const spokeIface = new ethers.Interface(SPOKE_ABI);
const hubIface = new ethers.Interface(HUB_ABI);
const oracleIface = new ethers.Interface(ORACLE_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const wethIface = new ethers.Interface(WETH_ABI);

function minBig(a, b) {
  return a < b ? a : b;
}

function capRaw(cap, max, decimals) {
  if (cap >= max) return null;
  return cap * 10n ** BigInt(decimals);
}

function roomUnder(cap, used) {
  if (cap == null) return ethers.MaxUint256;
  return cap > used ? cap - used : 0n;
}

async function rpc(method, params, fetchImpl) {
  const response = await fetchImpl(ETH_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error("Ethereum did not answer.");
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Ethereum rejected the request.");
  return body.result;
}

async function ethCall(to, data, fetchImpl) {
  return rpc("eth_call", [{ to, data }, "latest"], fetchImpl);
}

async function callIface(iface, address, name, args, fetchImpl) {
  const data = iface.encodeFunctionData(name, args);
  const raw = await ethCall(address, data, fetchImpl);
  return iface.decodeFunctionResult(name, raw);
}

export function valueOf(amount, price, decimals) {
  return amount * price * WAD / 10n ** BigInt(decimals);
}

function healthWad(weightedWad, debtRay) {
  if (debtRay <= 0n) return null;
  return weightedWad * RAY / debtRay;
}

export function healthAfterBorrow(market, asset, extraDebt) {
  const account = market.account;
  const weighted = account.totalCollateralValue * account.avgCollateralFactorWad;
  const debtRay = account.totalDebtValueRay + valueOf(extraDebt, asset.price, asset.decimals) * RAY;
  return healthWad(weighted, debtRay);
}

export function healthAfterWithdraw(market, reserve, amount) {
  const account = market.account;
  if (account.totalDebtValueRay <= 0n) return null;
  let weighted = account.totalCollateralValue * account.avgCollateralFactorWad;
  if (reserve.enabledAsCollateral && reserve.collateralFactorBps > 0) {
    const removed = valueOf(amount, reserve.price, reserve.decimals) * BigInt(reserve.collateralFactorBps) * 10n ** 14n;
    weighted = weighted > removed ? weighted - removed : 0n;
  }
  return healthWad(weighted, account.totalDebtValueRay);
}

export function healthAfterRepay(market, asset, amount) {
  const account = market.account;
  const weighted = account.totalCollateralValue * account.avgCollateralFactorWad;
  const repaid = valueOf(amount, asset.price, asset.decimals) * RAY;
  const debtRay = account.totalDebtValueRay > repaid ? account.totalDebtValueRay - repaid : 0n;
  return healthWad(weighted, debtRay);
}

export function maxSafeBorrow(market, asset) {
  const account = market.account;
  if (!asset.canBorrow || asset.price <= 0n) return 0n;
  const weighted = account.totalCollateralValue * account.avgCollateralFactorWad;
  const allowedDebtRay = weighted * RAY / MIN_SAFE_WAD;
  if (allowedDebtRay <= account.totalDebtValueRay) return 0n;
  const headroomValue = (allowedDebtRay - account.totalDebtValueRay) / RAY;
  const byHealth = headroomValue * 10n ** BigInt(asset.decimals) / (asset.price * WAD);
  const byLimits = asset.borrowRoom === ethers.MaxUint256 ? byHealth : asset.borrowRoom * LIMIT_USE_BPS / 10_000n;
  return minBig(byHealth, byLimits);
}

export function maxSafeWithdraw(market, reserve) {
  if (reserve.supplied <= 0n) return 0n;
  const account = market.account;
  if (account.totalDebtValueRay <= 0n || !reserve.enabledAsCollateral || reserve.collateralFactorBps === 0) {
    return reserve.supplied;
  }
  const weighted = account.totalCollateralValue * account.avgCollateralFactorWad;
  const keep = account.totalDebtValueRay * MIN_SAFE_WAD / RAY;
  if (weighted <= keep) return 0n;
  const removableWeighted = weighted - keep;
  const weightPerWholeUnit = reserve.price * BigInt(reserve.collateralFactorBps) * 10n ** 14n * WAD;
  if (weightPerWholeUnit <= 0n) return reserve.supplied;
  return minBig(reserve.supplied, removableWeighted * 10n ** BigInt(reserve.decimals) / weightPerWholeUnit);
}

export function healthToNumber(wad) {
  if (wad == null) return null;
  if (wad > 1_000_000n * WAD) return Infinity;
  return Number(wad / 10n ** 12n) / 1e6;
}

export function formatHealth(wad) {
  const n = healthToNumber(wad);
  if (n == null || !Number.isFinite(n)) return "No debt";
  return n.toFixed(2);
}

export function maxWrappableEth(market) {
  return market.ethBalance > market.ethGasReserve ? market.ethBalance - market.ethGasReserve : 0n;
}

export function parseAaveAmount(text, decimals) {
  const places = Number(decimals);
  const raw = String(text ?? "").trim();
  if (!Number.isInteger(places) || places < 0 || places > 18) throw new Error("Enter an amount.");
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error("Enter an amount.");
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > places) throw new Error("That amount has too many decimals.");
  const padded = (frac + "0".repeat(places)).slice(0, places);
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(padded || "0");
}

function approveStep(token, symbol, amount) {
  return {
    label: `Approve ${symbol} for the Aave Main Spoke`,
    to: token,
    data: erc20Iface.encodeFunctionData("approve", [AAVE_MAIN_SPOKE, amount]),
  };
}

async function readAllowance(token, owner, fetchImpl) {
  const decoded = await callIface(erc20Iface, token, "allowance", [owner, AAVE_MAIN_SPOKE], fetchImpl);
  return decoded[0];
}

async function readTokenBalance(token, owner, fetchImpl) {
  const decoded = await callIface(erc20Iface, token, "balanceOf", [owner], fetchImpl);
  return decoded[0];
}

async function approvalSteps(reserve, owner, amount, fetchImpl) {
  const current = await readAllowance(reserve.underlying, owner, fetchImpl);
  if (current >= amount) return [];
  const steps = [];
  if (current > 0n) steps.push(approveStep(reserve.underlying, reserve.symbol, 0n));
  steps.push(approveStep(reserve.underlying, reserve.symbol, amount));
  return steps;
}

function wrapStep(amount, label) {
  return { label, to: ETH_WETH, data: wethIface.encodeFunctionData("deposit"), value: amount };
}

function unwrapStep(amount, label) {
  return { label, to: ETH_WETH, data: wethIface.encodeFunctionData("withdraw", [amount]) };
}

export async function planSupply(owner, market, reserve, amount, fromEth = false, fetchImpl = globalThis.fetch) {
  if (!reserve.collateral) throw new Error(`${reserve.symbol} is not offered as collateral here.`);
  if (reserve.paused || reserve.frozen) throw new Error(`${reserve.symbol} is paused or frozen on Aave.`);
  if (reserve.collateralFactorBps <= 0) throw new Error(`${reserve.symbol} does not count as collateral on the Main Spoke.`);
  if (amount > reserve.supplyRoom) {
    throw new Error(`Aave's supply cap for ${reserve.symbol} leaves room for ${ethers.formatUnits(reserve.supplyRoom, reserve.decimals)}.`);
  }
  const steps = [];
  if (fromEth) {
    if (reserve.id !== 0) throw new Error("Only ETH can be wrapped here.");
    const max = maxWrappableEth(market);
    if (amount > max) {
      throw new Error(`Keep ${ethers.formatEther(market.ethGasReserve)} ETH for gas. The most ETH you can supply is ${ethers.formatEther(max)}.`);
    }
    steps.push(wrapStep(amount, "Wrap ETH to WETH"));
  } else {
    const balance = await readTokenBalance(reserve.underlying, owner, fetchImpl);
    if (amount > balance) {
      throw new Error(`Only ${ethers.formatUnits(balance, reserve.decimals)} ${reserve.symbol} is in this wallet.`);
    }
  }
  steps.push(...await approvalSteps(reserve, owner, amount, fetchImpl));
  steps.push({
    label: `Supply ${reserve.symbol}`,
    to: AAVE_MAIN_SPOKE,
    data: spokeIface.encodeFunctionData("supply", [reserve.id, amount, owner]),
  });
  if (!reserve.enabledAsCollateral) {
    steps.push({
      label: `Enable ${reserve.symbol} as collateral`,
      to: AAVE_MAIN_SPOKE,
      data: spokeIface.encodeFunctionData("setUsingAsCollateral", [reserve.id, true, owner]),
    });
  }
  return steps;
}

export function planBorrow(owner, market, asset, amount, unwrap) {
  if (!asset.canBorrow) throw new Error(`Borrowing ${asset.symbol} is turned off on Aave right now.`);
  if (amount > asset.borrowRoom) throw new Error(`That is above the remaining ${asset.symbol} borrow cap or pool liquidity.`);
  const after = healthAfterBorrow(market, asset, amount);
  if (after != null && after < MIN_SAFE_WAD) {
    throw new Error(`Blocked: this borrow would leave a health factor of ${formatHealth(after)}. This wallet requires at least 1.5.`);
  }
  const steps = [{
    label: `Borrow ${asset.symbol}`,
    to: AAVE_MAIN_SPOKE,
    data: spokeIface.encodeFunctionData("borrow", [asset.id, amount, owner]),
  }];
  if (unwrap && asset.id === 0) steps.push(unwrapStep(amount, "Unwrap the borrowed WETH to ETH"));
  return steps;
}

export async function planRepay(owner, market, asset, amount, full, fetchImpl = globalThis.fetch) {
  if (asset.paused) throw new Error(`${asset.symbol} is paused on Aave, so it cannot be repaid right now.`);
  if (asset.debt <= 0n) throw new Error(`There is no ${asset.symbol} debt to repay.`);
  if (!full && amount > asset.debt) throw new Error(`That is more than the ${asset.symbol} debt.`);
  const need = full ? asset.debt * FULL_REPAY_BUFFER_BPS / 10_000n : amount;
  const balance = await readTokenBalance(asset.underlying, owner, fetchImpl);
  const steps = [];
  if (balance < need) {
    if (asset.id === 0) {
      const shortfall = need - balance;
      if (shortfall > maxWrappableEth(market)) {
        throw new Error(`Not enough ETH and WETH for that repayment while keeping ${ethers.formatEther(market.ethGasReserve)} ETH for gas.`);
      }
      steps.push(wrapStep(shortfall, "Wrap ETH to WETH for the repayment"));
    } else if (!full || balance < asset.debt) {
      throw new Error(`Only ${ethers.formatUnits(balance, asset.decimals)} ${asset.symbol} is in this wallet, less than the ${full ? "debt" : "amount"}.`);
    }
  }
  steps.push(...await approvalSteps(asset, owner, need, fetchImpl));
  steps.push({
    label: full ? `Repay all ${asset.symbol} debt` : `Repay ${asset.symbol}`,
    to: AAVE_MAIN_SPOKE,
    data: spokeIface.encodeFunctionData("repay", [asset.id, full ? ethers.MaxUint256 : amount, owner]),
  });
  return steps;
}

export function planWithdraw(owner, market, reserve, amount, full, unwrap = false) {
  if (reserve.supplied <= 0n) throw new Error(`No ${reserve.symbol} is supplied.`);
  if (!full && amount > reserve.supplied) {
    throw new Error(`Only ${ethers.formatUnits(reserve.supplied, reserve.decimals)} ${reserve.symbol} is supplied.`);
  }
  const sent = full ? reserve.supplied : amount;
  const after = healthAfterWithdraw(market, reserve, sent);
  if (after != null && after < MIN_SAFE_WAD) {
    throw new Error(`Blocked: this withdrawal would leave a health factor of ${formatHealth(after)}. This wallet requires at least 1.5.`);
  }
  const steps = [{
    label: `Withdraw ${reserve.symbol}`,
    to: AAVE_MAIN_SPOKE,
    data: spokeIface.encodeFunctionData("withdraw", [reserve.id, full ? ethers.MaxUint256 : amount, owner]),
  }];
  if (unwrap && reserve.id === 0) steps.push(unwrapStep(sent, "Unwrap the withdrawn WETH to ETH"));
  return steps;
}

async function gasReserve(fetchImpl) {
  let price = 1n;
  try {
    const block = await rpc("eth_getBlockByNumber", ["latest", false], fetchImpl);
    const tip = BigInt(await rpc("eth_maxPriorityFeePerGas", [], fetchImpl));
    price = BigInt(block?.baseFeePerGas || 0) * 2n + tip;
  } catch {
    price = BigInt(await rpc("eth_gasPrice", [], fetchImpl));
  }
  if (price <= 0n) price = 1n;
  const scaled = price * GAS_RESERVE_UNITS;
  return scaled > GAS_RESERVE_FLOOR ? scaled : GAS_RESERVE_FLOOR;
}

export async function loadAaveMarket(user, fetchImpl = globalThis.fetch) {
  const owner = ethers.getAddress(user);
  const chainId = BigInt(await rpc("eth_chainId", [], fetchImpl));
  if (chainId !== 1n) throw new Error("Ethereum RPC is not mainnet.");
  const oracleAddress = (await callIface(spokeIface, AAVE_MAIN_SPOKE, "ORACLE", [], fetchImpl))[0];
  const [priceDecimalsRaw, maxCap, acct, ethBalance, ethGasReserve] = await Promise.all([
    callIface(oracleIface, oracleAddress, "decimals", [], fetchImpl).then((row) => row[0]),
    callIface(hubIface, AAVE_CORE_HUB, "MAX_ALLOWED_SPOKE_CAP", [], fetchImpl).then((row) => row[0]),
    callIface(spokeIface, AAVE_MAIN_SPOKE, "getUserAccountData", [owner], fetchImpl).then((row) => row[0]),
    rpc("eth_getBalance", [owner, "latest"], fetchImpl).then(BigInt),
    gasReserve(fetchImpl),
  ]);
  const skipped = [];
  const rows = await Promise.all(AAVE_RESERVES.map(async (def) => {
    const reserve = (await callIface(spokeIface, AAVE_MAIN_SPOKE, "getReserve", [def.id], fetchImpl))[0];
    if (String(reserve.underlying).toLowerCase() !== def.underlying.toLowerCase() || Number(reserve.decimals) !== def.decimals) {
      skipped.push(def.symbol);
      return null;
    }
    const assetId = BigInt(reserve.assetId);
    const [config, position, supplied, debt, status, price, balance, hubSpoke, added, owed, liquidity, rate] = await Promise.all([
      callIface(spokeIface, AAVE_MAIN_SPOKE, "getReserveConfig", [def.id], fetchImpl).then((row) => row[0]),
      callIface(spokeIface, AAVE_MAIN_SPOKE, "getUserPosition", [def.id, owner], fetchImpl).then((row) => row[0]),
      callIface(spokeIface, AAVE_MAIN_SPOKE, "getUserSuppliedAssets", [def.id, owner], fetchImpl).then((row) => row[0]),
      callIface(spokeIface, AAVE_MAIN_SPOKE, "getUserTotalDebt", [def.id, owner], fetchImpl).then((row) => row[0]),
      callIface(spokeIface, AAVE_MAIN_SPOKE, "getUserReserveStatus", [def.id, owner], fetchImpl),
      callIface(oracleIface, oracleAddress, "getReservePrice", [def.id], fetchImpl).then((row) => row[0]),
      callIface(erc20Iface, def.underlying, "balanceOf", [owner], fetchImpl).then((row) => row[0]),
      callIface(hubIface, AAVE_CORE_HUB, "getSpoke", [assetId, AAVE_MAIN_SPOKE], fetchImpl).then((row) => row[0]),
      callIface(hubIface, AAVE_CORE_HUB, "getSpokeAddedAssets", [assetId, AAVE_MAIN_SPOKE], fetchImpl).then((row) => row[0]),
      callIface(hubIface, AAVE_CORE_HUB, "getSpokeTotalOwed", [assetId, AAVE_MAIN_SPOKE], fetchImpl).then((row) => row[0]),
      callIface(hubIface, AAVE_CORE_HUB, "getAssetLiquidity", [assetId], fetchImpl).then((row) => row[0]),
      callIface(hubIface, AAVE_CORE_HUB, "getAssetDrawnRate", [assetId], fetchImpl).then((row) => row[0]),
    ]);
    const key = supplied > 0n ? Number(position.dynamicConfigKey) : Number(reserve.dynamicConfigKey);
    const dyn = (await callIface(spokeIface, AAVE_MAIN_SPOKE, "getDynamicReserveConfig", [def.id, key], fetchImpl))[0];
    const active = Boolean(hubSpoke.active) && !hubSpoke.halted;
    return {
      ...def,
      price,
      walletBalance: balance,
      supplied,
      debt,
      enabledAsCollateral: Boolean(status[0]),
      collateralFactorBps: Number(dyn.collateralFactor),
      frozen: Boolean(config.frozen),
      paused: Boolean(config.paused),
      canBorrow: def.borrow && Boolean(config.borrowable) && !config.paused && !config.frozen && active,
      supplyRoom: active ? roomUnder(capRaw(BigInt(hubSpoke.addCap), maxCap, def.decimals), added) : 0n,
      borrowRoom: active
        ? minBig(roomUnder(capRaw(BigInt(hubSpoke.drawCap), maxCap, def.decimals), owed), liquidity)
        : 0n,
      drawnRateRay: rate,
    };
  }));
  const healthRaw = BigInt(acct.healthFactor);
  const block = Number(await rpc("eth_blockNumber", [], fetchImpl));
  return {
    block,
    priceDecimals: Number(priceDecimalsRaw),
    account: {
      healthFactorWad: BigInt(acct.borrowCount) === 0n || BigInt(acct.totalDebtValueRay) === 0n ? null : healthRaw,
      riskPremiumBps: Number(acct.riskPremium),
      avgCollateralFactorWad: BigInt(acct.avgCollateralFactor),
      totalCollateralValue: BigInt(acct.totalCollateralValue),
      totalDebtValueRay: BigInt(acct.totalDebtValueRay),
      borrowCount: Number(acct.borrowCount),
      activeCollateralCount: Number(acct.activeCollateralCount),
    },
    reserves: rows.filter(Boolean),
    ethBalance,
    ethGasReserve,
    skipped,
  };
}
