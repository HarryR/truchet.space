FOUNDRY_VERSION := v1.5.1
PLATFORM        := linux
ARCH            := amd64
FOUNDRY_URL     := https://github.com/foundry-rs/foundry/releases/download/$(FOUNDRY_VERSION)/foundry_$(FOUNDRY_VERSION)_$(PLATFORM)_$(ARCH).tar.gz

FORGE := bin/forge
CAST  := bin/cast
ANVIL := bin/anvil

# Download and extract foundry toolchain
bin/.installed-$(FOUNDRY_VERSION):
	@mkdir -p bin
	curl -sSL $(FOUNDRY_URL) | tar xz -C bin
	@touch $@

$(FORGE) $(CAST) $(ANVIL): bin/.installed-$(FOUNDRY_VERSION)

# Ensure submodules are initialized (forge-std etc.)
lib/forge-std/src/Test.sol:
	git submodule update --init --recursive

deps: lib/forge-std/src/Test.sol

build: $(FORGE) deps
	$(FORGE) build

test: $(FORGE) deps
	$(FORGE) test -vvv

snapshot: $(FORGE) deps
	$(FORGE) snapshot

deploy-local: $(FORGE) $(ANVIL) deps
	$(ANVIL) &
	sleep 1
	$(FORGE) script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

clean:
	rm -rf out cache

distclean: clean
	rm -rf bin

.PHONY: build test snapshot deploy-local clean distclean deps
