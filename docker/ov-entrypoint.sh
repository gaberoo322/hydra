#!/bin/sh
# Generate ov.conf from template with the actual API key
sed "s/PLACEHOLDER/${OPENAI_API_KEY}/g" /app/ov.conf.template > /app/ov.conf
exec openviking-server
