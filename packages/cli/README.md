# @whatsap-automat/cli

Developer CLI tool for scaffolding, validating, packaging, and diagnosing Whatsap-Automat extensions.

## Usage

```bash
# Display help
automat --help

# Initialize a new extension
automat init my-channel --type=channel
automat init my-tool --type=tool
automat init my-ui --type=ui

# Validate manifest schema and permissions (SEC-009)
automat validate manifest.json

# Pack extension into .tgz archive with sha256 checksum
automat pack .

# System environment diagnostics
automat doctor
```
