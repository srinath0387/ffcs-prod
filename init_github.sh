#!/bin/bash
echo "Creating GitHub repository using gh CLI..."
gh repo create ffcs-system --public --source=. --remote=origin --push
