#!/bin/bash
# Patch IKA SDK for performance: increase batch size from 50 to 250
SDK_FILE="node_modules/@ika.xyz/sdk/dist/esm/client/ika-client.js"
if [ -f "$SDK_FILE" ]; then
  sed -i 's/const batchSize = 50;/const batchSize = 250;/' "$SDK_FILE"
  echo "Patched IKA SDK batch size: 50 → 250"
fi
