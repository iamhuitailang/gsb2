"""Demo configuration — synthetic values only, no working credentials."""

# AWS: a key id plus a secret. Both are fabricated; the threshold tests
# documented in tests/test_tasks.py use these exact values.
AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

# Generic API key that also matches the more specific GitHub rule below.
# The overlap should be resolved in favour of the GitHub rule and reported once.
GITHUB = {"api_key": "ghp_0123456789abcdefghijklmnopqrstuvwxyz012345"}

# A deliberately low-entropy generic value: the generic rule's entropy floor
# should reject it, so no finding is produced here.
SAMPLE_API_KEY = 'api_key = "aaaaaaaaaaaaaaaaaaaaaaaa"'

# Placeholder that the allow-list suppresses.
PLACEHOLDER_TOKEN = 'api_key = "your_api_key_here_0000"'
