#!/usr/bin/env node
/**
 * beacon-forensics v0.1.0
 * CLI for Ethereum validator cluster attribution.
 * Zero npm deps. Node 20+.
 *
 * Usage: node index.mjs lookup --withdrawal <address>
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

var RPC = "https://ethereum-rpc.publicnode.com";
var BEACONCHA = "https://beaconcha.in/api/v1";
var BLOCKSCOUT = "https://eth.blockscout.com";

function die(msg) { console.error(JSON.stringify({ error: msg })); process.exit(1); }

async function fetchJSON(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + url.split("?")[0]);
  return r.json();
}

async function rpcCall(method, params) {
  var r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
  });
  var d = await r.json();
  if (d.error) return null;
  return d.result;
}

// ─── Safe detection ──────────────────────────────────────────────────────────
async function detectSafe(address) {
  // getOwners() = 0xa0e67e2b, getThreshold() = 0xe75235b8
  var ownersHex = await rpcCall("eth_call", [{ to: address, data: "0xa0e67e2b" }, "latest"]);
  if (!ownersHex || ownersHex === "0x" || ownersHex.length < 66) return null;
  var threshHex = await rpcCall("eth_call", [{ to: address, data: "0xe75235b8" }, "latest"]);
  var threshold = threshHex ? parseInt(threshHex, 16) : 0;
  // Decode dynamic array: offset at 0x20, length at 0x40, addresses at 0x60+
  try {
    var stripped = ownersHex.slice(2); // remove 0x
    var arrLen = parseInt(stripped.slice(64, 128), 16);
    var owners = [];
    for (var i = 0; i < arrLen; i++) {
      var raw = stripped.slice(128 + i * 64, 128 + (i + 1) * 64);
      owners.push("0x" + raw.slice(24));
    }
    return { type: "gnosis_safe", threshold: threshold, owners: owners };
  } catch (e) { return null; }
}

// ─── Validator lookup via Blockscout withdrawals API ─────────────────────────
async function getValidatorsByWithdrawal(address) {
  var addr = address.toLowerCase();
  var url = BLOCKSCOUT + "/api/v2/addresses/" + addr + "/withdrawals";
  var d = await fetchJSON(url);
  var items = d.items || [];
  // Dedupe by validator index
  var seen = {};
  var validators = [];
  for (var i = 0; i < items.length; i++) {
    var w = items[i];
    var idx = w.index !== undefined ? w.validator_index : (w.validator_index || w.validatorIndex);
    if (idx === undefined) continue;
    if (seen[idx]) {
      seen[idx].withdrawal_count++;
      seen[idx].total_withdrawn += parseFloat(w.amount || w.value || "0") / 1e18;
      continue;
    }
    seen[idx] = {
      index: idx,
      status: "active",
      withdrawal_count: 1,
      total_withdrawn: parseFloat(w.amount || w.value || "0") / 1e18,
    };
    validators.push(seen[idx]);
  }
  // If there are more pages, fetch them
  var nextParams = d.next_page_params;
  var pages = 0;
  while (nextParams && pages < 10) {
    pages++;
    var qs = Object.keys(nextParams).map(function(k) { return k + "=" + nextParams[k]; }).join("&");
    var d2 = await fetchJSON(BLOCKSCOUT + "/api/v2/addresses/" + addr + "/withdrawals?" + qs);
    var items2 = d2.items || [];
    for (var j = 0; j < items2.length; j++) {
      var w2 = items2[j];
      var idx2 = w2.validator_index;
      if (idx2 === undefined) continue;
      if (seen[idx2]) {
        seen[idx2].withdrawal_count++;
        seen[idx2].total_withdrawn += parseFloat(w2.amount || "0") / 1e18;
        continue;
      }
      seen[idx2] = {
        index: idx2,
        status: "active",
        withdrawal_count: 1,
        total_withdrawn: parseFloat(w2.amount || "0") / 1e18,
      };
      validators.push(seen[idx2]);
    }
    nextParams = d2.next_page_params;
  }
  return validators;
}

// ─── Depositor clustering via chain trace ────────────────────────────────────
var DEPOSIT_CONTRACT = "0x00000000219ab540356cbb839cbe05303d7705fa";
var BQ_PROJECT = "astute-baton-471810-g6";

async function bqDepositorQuery(address) {
  var addrClean = address.toLowerCase().replace("0x", "");
  try {
    var token = execSync("gcloud auth print-access-token", { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (!token || token.length < 20) return null;
    var sql = "SELECT t.from_address as depositor, COUNT(*) as deposit_count, " +
      "CAST(SUM(CAST(t.value AS FLOAT64)/1e18) AS FLOAT64) as total_eth " +
      "FROM `bigquery-public-data.crypto_ethereum.logs` l " +
      "JOIN `bigquery-public-data.crypto_ethereum.transactions` t " +
      "ON l.transaction_hash = t.hash AND l.block_number = t.block_number " +
      "WHERE l.address = '0x00000000219ab540356cbb839cbe05303d7705fa' " +
      "AND LOWER(l.data) LIKE '%" + addrClean + "%' " +
      "GROUP BY depositor ORDER BY deposit_count DESC";
    var url = "https://bigquery.googleapis.com/bigquery/v2/projects/" + BQ_PROJECT + "/queries";
    var r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 120000 }),
    });
    var d = await r.json();
    if (d.error || !d.jobComplete || !d.rows) return null;
    return d.rows.map(function(row) {
      return {
        address: row.f[0].v,
        deposit_count: parseInt(row.f[1].v),
        total_eth: parseFloat(row.f[2].v),
        source: "bigquery",
      };
    });
  } catch (e) { return null; }
}

async function getDepositorCluster(address) {
  var addr = address.toLowerCase();
  // Step 1: Find who funded the withdrawal address (Safe or EOA)
  var txUrl = BLOCKSCOUT + "/api/v2/addresses/" + addr + "/transactions";
  var funders = {};
  try {
    var d = await fetchJSON(txUrl);
    var items = d.items || [];
    for (var i = 0; i < items.length; i++) {
      var tx = items[i];
      var from = tx.from && tx.from.hash;
      var to = tx.to && tx.to.hash;
      // Inbound ETH transfers to our address
      if (to && to.toLowerCase() === addr && from) {
        var f = from.toLowerCase();
        funders[f] = (funders[f] || 0) + 1;
      }
    }
  } catch (e) { /* continue with empty funders */ }

  // Step 2: For each funder, check if they deposited to the Beacon Deposit Contract
  var depositors = [];
  var funderList = Object.keys(funders);
  for (var j = 0; j < funderList.length; j++) {
    var funder = funderList[j];
    try {
      var depUrl = BLOCKSCOUT + "/api/v2/addresses/" + funder + "/transactions?filter=to";
      var depData = await fetchJSON(depUrl);
      var depItems = depData.items || [];
      var depositCount = 0;
      var depositEth = 0;
      for (var k = 0; k < depItems.length; k++) {
        var dtx = depItems[k];
        var dTo = dtx.to && dtx.to.hash;
        if (dTo && dTo.toLowerCase() === DEPOSIT_CONTRACT) {
          depositCount++;
          var val = dtx.value || "0";
          depositEth += parseInt(val) / 1e18;
        }
      }
      if (depositCount > 0) {
        depositors.push({ address: funder, deposit_count: depositCount, total_eth: depositEth });
      }
    } catch (e) { continue; }
  }
  // Also check funders' funders (one hop back) for treasury detection
  // Skip for v0.2.0 — direct funders are sufficient
  depositors.sort(function(a, b) { return b.deposit_count - a.deposit_count; });
  return depositors;
}

// ─── Cross-Safe owner correlation ────────────────────────────────────────────
var SAFE_TX_API = "https://safe-transaction-mainnet.safe.global/api/v1";

async function getChecksumAddress(addr) {
  try {
    var url = BLOCKSCOUT + "/api/v2/addresses/" + addr.toLowerCase();
    var r = await fetch(url);
    if (!r.ok) return addr;
    var d = await r.json();
    return d.hash || addr;
  } catch (e) { return addr; }
}

async function getSafesForOwner(checksumAddr) {
  try {
    var url = SAFE_TX_API + "/owners/" + checksumAddr + "/safes/";
    var r = await fetch(url);
    if (!r.ok) return [];
    var d = await r.json();
    return d.safes || [];
  } catch (e) { return []; }
}

async function correlateOwners(owners, currentSafe) {
  var checksummed = [];
  for (var i = 0; i < owners.length; i++) {
    checksummed.push(await getChecksumAddress(owners[i]));
  }
  // Collect all Safes per owner, count how many owners each Safe appears in
  var safeCounts = {}; // safeAddr → count of owners
  for (var k = 0; k < checksummed.length; k++) {
    process.stderr.write("  Owner " + (k + 1) + "/" + owners.length + "...\n");
    var safes = await getSafesForOwner(checksummed[k]);
    for (var m = 0; m < safes.length; m++) {
      var s = safes[m].toLowerCase();
      safeCounts[s] = (safeCounts[s] || 0) + 1;
    }
  }
  delete safeCounts[currentSafe.toLowerCase()];
  // Classify: exact = all owners present, partial = 2+ but not all
  var ownerCount = owners.length;
  var exact = [];
  var partial = [];
  for (var addr in safeCounts) {
    if (safeCounts[addr] === ownerCount) exact.push(addr);
    else if (safeCounts[addr] >= 2) partial.push({ address: addr, overlap: safeCounts[addr] });
  }
  partial.sort(function(a, b) { return b.overlap - a.overlap; });
  return { exact: exact, partial: partial };
}

async function countValidatorsForSafe(safeAddr) {
  try {
    var url = BLOCKSCOUT + "/api/v2/addresses/" + safeAddr.toLowerCase() + "/withdrawals";
    var d = await fetchJSON(url);
    var items = d.items || [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var idx = items[i].validator_index;
      if (idx !== undefined) seen[idx] = 1;
    }
    return Object.keys(seen).length;
  } catch (e) { return 0; }
}

// ─── Operator heuristics ─────────────────────────────────────────────────────
function inferOperator(safe, validatorCount, depositorEoas) {
  var base = 0.3;
  var pattern = "unknown";
  var operator = "unknown";
  if (safe) {
    base = 0.5;
    pattern = "multisig_withdrawal";
    operator = "institutional_unknown";
    if (safe.owners.length >= 4 && safe.threshold >= 2) { base = 0.7; pattern = "managed_multisig"; }
    if (safe.owners.length === 6 && safe.threshold === 3 && validatorCount >= 20) { base = 0.85; pattern = "staking-as-a-service"; operator = "unlabeled_institutional"; }
  } else {
    pattern = "eoa_withdrawal";
  }
  if (depositorEoas.length > 0) { base = Math.min(base + 0.06, 0.95); }
  return { suspected_operator: operator, pattern: pattern, confidence: Math.round(base * 100) / 100 };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  var args = process.argv.slice(2);
  if (args[0] !== "lookup" || args[1] !== "--withdrawal" || !args[2]) {
    die("Usage: beacon-forensics lookup --withdrawal <address>");
  }
  var address = args[2];
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) die("Invalid address: " + address);

  // Optional: --depositor flag for BQ-verified depositor
  var knownDepositor = null;
  for (var a = 3; a < args.length; a++) {
    if (args[a] === "--depositor" && args[a + 1]) knownDepositor = args[a + 1];
  }

  process.stderr.write("Fetching validators...\n");
  var validators = await getValidatorsByWithdrawal(address);
  if (!validators.length) die("No validators found for withdrawal address " + address);

  process.stderr.write("Found " + validators.length + " validators. Checking Safe...\n");
  var safe = await detectSafe(address);
  var withdrawalType = safe ? "gnosis_safe" : "eoa";

  // Cross-Safe owner correlation
  var ownerCorrelation = null;
  if (safe && safe.owners.length > 0) {
    process.stderr.write("Correlating Safe owners...\n");
    try {
      var corr = await correlateOwners(safe.owners, address);
      var exactCount = corr.exact.length;
      var partialCount = corr.partial.length;
      var totalMatched = exactCount + partialCount;
      if (totalMatched > 0) {
        // Count validators for exact-match Safes only
        var exactValidators = 0;
        var exactWithdrawalAddrs = [];
        process.stderr.write("  Checking " + exactCount + " exact-match Safes for validators...\n");
        for (var si = 0; si < corr.exact.length; si++) {
          var vc = await countValidatorsForSafe(corr.exact[si]);
          if (vc > 0) {
            exactWithdrawalAddrs.push(corr.exact[si]);
            exactValidators += vc;
          }
        }
        ownerCorrelation = {
          owners: safe.owners,
          matching_safes_found: totalMatched,
          exact_owner_set_matches: exactCount,
          partial_overlap_matches: partialCount,
          correlated_withdrawal_addresses: exactWithdrawalAddrs,
          correlated_validator_count: exactValidators,
          partial_overlaps: corr.partial.slice(0, 10),
        };
        process.stderr.write("  exact=" + exactCount + " partial=" + partialCount + " validators=" + exactValidators + "\n");
      }
    } catch (e) { /* continue without correlation */ }
  }

  process.stderr.write("Resolving depositors...\n");
  var addrClean = address.toLowerCase().replace("0x", "");
  var manualQuery = "SELECT t.from_address as depositor, COUNT(*) as deposit_count, SUM(CAST(t.value AS FLOAT64)/1e18) as total_eth FROM `bigquery-public-data.crypto_ethereum.logs` l JOIN `bigquery-public-data.crypto_ethereum.transactions` t ON l.transaction_hash = t.hash AND l.block_number = t.block_number WHERE l.address = '0x00000000219ab540356cbb839cbe05303d7705fa' AND LOWER(l.data) LIKE '%" + addrClean + "%' GROUP BY depositor ORDER BY deposit_count DESC";

  var depositAttribution = {
    method: "unresolved",
    depositor_eoas: [],
    deposit_count_matched: 0,
    total_eth_deposited: 0,
    query: null,
  };

  // 1. BigQuery live
  try {
    process.stderr.write("  Trying BigQuery...\n");
    var bqResult = await bqDepositorQuery(address);
    if (bqResult && bqResult.length > 0) {
      depositAttribution = {
        method: "bigquery_live",
        depositor_eoas: bqResult.map(function(d) { return d.address; }),
        deposit_count_matched: bqResult.reduce(function(s, d) { return s + d.deposit_count; }, 0),
        total_eth_deposited: bqResult.reduce(function(s, d) { return s + d.total_eth; }, 0),
        query: null,
      };
      process.stderr.write("  BQ resolved: " + depositAttribution.depositor_eoas.length + " depositor(s)\n");
    }
  } catch (e) { /* keep going */ }

  // 2. Chain-trace fallback
  if (!depositAttribution.depositor_eoas.length) {
    try {
      process.stderr.write("  Trying chain trace...\n");
      var traced = await getDepositorCluster(address);
      if (traced && traced.length > 0) {
        depositAttribution = {
          method: "chain_trace",
          depositor_eoas: traced.map(function(d) { return d.address; }),
          deposit_count_matched: traced.reduce(function(s, d) { return s + d.deposit_count; }, 0),
          total_eth_deposited: traced.reduce(function(s, d) { return s + d.total_eth; }, 0),
          query: null,
        };
      }
    } catch (e) { /* keep going */ }
  }

  // 3. Manual override via --depositor flag
  if (!depositAttribution.depositor_eoas.length && knownDepositor) {
    depositAttribution = {
      method: "flag_override",
      depositor_eoas: [knownDepositor.toLowerCase()],
      deposit_count_matched: 0,
      total_eth_deposited: 0,
      query: null,
    };
  }

  // 4. Always include query if unresolved
  if (depositAttribution.method === "unresolved") {
    depositAttribution.query = manualQuery;
  }

  var inference = inferOperator(safe, validators.length, depositAttribution.depositor_eoas);

  var result = {
    withdrawal_address: address,
    validators_found: validators.length,
    withdrawal_type: withdrawalType,
    deposit_attribution: depositAttribution,
    suspected_operator: inference.suspected_operator,
    pattern: inference.pattern,
    confidence: inference.confidence,
    validators: validators.map(function(v) {
      return { index: v.index, status: v.status, withdrawal_count: v.withdrawal_count, total_withdrawn: v.total_withdrawn };
    }),
  };

  if (safe) {
    result.safe = {
      threshold: safe.threshold,
      owner_count: safe.owners.length,
      owners: safe.owners,
    };
  }

  if (ownerCorrelation) {
    result.owner_correlation = ownerCorrelation;
    result.cluster_summary = {
      exact_match_safes: ownerCorrelation.exact_owner_set_matches,
      exact_match_withdrawal_addresses: ownerCorrelation.correlated_withdrawal_addresses.length,
      exact_match_validators: ownerCorrelation.correlated_validator_count + validators.length,
      estimated_staked_eth: (ownerCorrelation.correlated_validator_count + validators.length) * 32,
    };
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(function(e) { die(e.message); });
