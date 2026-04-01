#!/usr/bin/env node
/**
 * beacon-forensics v0.1.0
 * CLI for Ethereum validator cluster attribution.
 * Zero npm deps. Node 20+.
 *
 * Usage: node index.mjs lookup --withdrawal <address>
 */
import { createHash } from "node:crypto";

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

// ─── Operator heuristics ─────────────────────────────────────────────────────
function inferOperator(safe, validatorCount, depositors) {
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
  // Depositor data raises confidence
  if (depositors.length > 0 && depositors[0].deposit_count >= 10) {
    base = Math.min(base + 0.06, 0.95);
  }
  return { suspected_operator: operator, pattern: pattern, confidence: base };
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

  process.stderr.write("Tracing depositors...\n");
  var depositors = [];
  var depositMethod = "none";
  if (knownDepositor) {
    // BQ-verified depositor provided via flag
    depositors = [{ address: knownDepositor.toLowerCase(), deposit_count: -1, total_eth: -1, source: "user_provided" }];
    // Verify against deposit contract via Blockscout
    try {
      var depUrl = BLOCKSCOUT + "/api/v2/addresses/" + knownDepositor.toLowerCase() + "/transactions";
      var depData = await fetchJSON(depUrl);
      var depItems = depData.items || [];
      var dCount = 0;
      var dEth = 0;
      for (var di = 0; di < depItems.length; di++) {
        var dtx = depItems[di];
        var dTo = dtx.to && dtx.to.hash;
        if (dTo && dTo.toLowerCase() === DEPOSIT_CONTRACT) {
          dCount++;
          dEth += parseInt(dtx.value || "0") / 1e18;
        }
      }
      if (dCount > 0) {
        depositors = [{ address: knownDepositor.toLowerCase(), deposit_count: dCount, total_eth: dEth, source: "verified_onchain" }];
        depositMethod = "flag_verified";
      } else {
        depositMethod = "flag_unverified";
      }
    } catch (e) { depositMethod = "flag_unverified"; }
  } else {
    depositors = await getDepositorCluster(address);
    depositMethod = depositors.length > 0 ? "chain_trace" : "none";
  }

  var addrClean = address.toLowerCase().replace("0x", "");
  var bqQuery = "SELECT t.from_address as depositor, COUNT(*) as deposit_count, SUM(CAST(t.value AS FLOAT64)/1e18) as total_eth FROM `bigquery-public-data.crypto_ethereum.logs` l JOIN `bigquery-public-data.crypto_ethereum.transactions` t ON l.transaction_hash = t.hash AND l.block_number = t.block_number WHERE l.address = '0x00000000219ab540356cbb839cbe05303d7705fa' AND LOWER(l.data) LIKE '%" + addrClean + "%' GROUP BY depositor ORDER BY deposit_count DESC";

  var inference = inferOperator(safe, validators.length, depositors);

  var result = {
    withdrawal_address: address,
    validators_found: validators.length,
    withdrawal_type: withdrawalType,
    deposit_attribution: {
      method: depositMethod,
      depositor_eoas: depositors.map(function(d) { return d.address; }),
      deposit_count_matched: depositors.reduce(function(s, d) { return s + (d.deposit_count > 0 ? d.deposit_count : 0); }, 0),
      total_eth_deposited: depositors.reduce(function(s, d) { return s + (d.total_eth > 0 ? d.total_eth : 0); }, 0),
      depositors: depositors,
      bq_query: depositMethod === "none" ? bqQuery : undefined,
    },
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

  console.log(JSON.stringify(result, null, 2));
}

main().catch(function(e) { die(e.message); });
