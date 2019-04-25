#!/usr/bin/env sh
set -e

yarn run docs:build

cd docs

git init
git add -A
git commit -m 'deploy'

git push -f git@github.com:node-ts/bus.git master:gh-pages

cd -
