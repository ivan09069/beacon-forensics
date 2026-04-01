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

// ─── Depositor lookup via Blockscout ─────────────────────────────────────────
async function getDepositorCluster(address) {
  // Check internal txs TO the beacon deposit contract FROM this withdrawal address's funding chain
  // Simpler: check Blockscout for the withdrawal address's funding history
  var url = BLOCKSCOUT + "/api/v2/addresses/" + address + "/transactions?filter=to%7Cfrom";
  try {
    var d = await fetchJSON(url);
    var depositors = {};
    var items = d.items || [];
    for (var i = 0; i < items.length; i++) {
      var tx = items[i];
      var from = tx.from && tx.from.hash;
      if (from && from.toLowerCase() !== address.toLowerCase()) {
        depositors[from.toLowerCase()] = (depositors[from.toLowerCase()] || 0) + 1;
      }
    }
    return Object.keys(depositors).sort(function(a, b) { return depositors[b] - depositors[a]; });
  } catch (e) { return []; }
}

// ─── Operator heuristics ─────────────────────────────────────────────────────
function inferOperator(safe, validatorCount, depositors) {
  if (!safe) {
    return { suspected_operator: "unknown", pattern: "eoa_withdrawal", confidence: 0.3 };
  }
  var ownerCount = safe.owners.length;
  var threshold = safe.threshold;
  // Known patterns
  if (ownerCount === 6 && threshold === 3 && validatorCount >= 20) {
    return { suspected_operator: "unlabeled_institutional", pattern: "staking-as-a-service", confidence: 0.85 };
  }
  if (ownerCount >= 4 && threshold >= 2) {
    return { suspected_operator: "institutional_unknown", pattern: "managed_multisig", confidence: 0.7 };
  }
  if (ownerCount <= 2) {
    return { suspected_operator: "individual_or_small_team", pattern: "self_custody", confidence: 0.5 };
  }
  return { suspected_operator: "unknown", pattern: "multisig_withdrawal", confidence: 0.4 };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  var args = process.argv.slice(2);
  if (args[0] !== "lookup" || args[1] !== "--withdrawal" || !args[2]) {
    die("Usage: beacon-forensics lookup --withdrawal <address>");
  }
  var address = args[2];
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) die("Invalid address: " + address);

  process.stderr.write("Fetching validators...\n");
  var validators = await getValidatorsByWithdrawal(address);
  if (!validators.length) die("No validators found for withdrawal address " + address);

  process.stderr.write("Found " + validators.length + " validators. Checking Safe...\n");
  var safe = await detectSafe(address);
  var withdrawalType = safe ? "gnosis_safe" : "eoa";

  process.stderr.write("Getting depositor cluster...\n");
  var depositors = await getDepositorCluster(address);

  var inference = inferOperator(safe, validators.length, depositors);

  var result = {
    withdrawal_address: address,
    validators_found: validators.length,
    withdrawal_type: withdrawalType,
    depositor_cluster: depositors.slice(0, 10),
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
