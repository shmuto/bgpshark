{
  description = "BGPShark — browser-based pcap analyzer for BGP sessions";

  inputs = {
    # Pinned rather than tracking a branch because of Playwright: the browsers
    # have to come from nixpkgs (the ones Playwright downloads are dynamically
    # linked against libraries a Nix system does not provide), and a browser
    # build only works with the driver version that expects it. This revision
    # ships playwright-driver 1.61.1, which is why package.json pins
    # @playwright/test to the same version. Bump both together — see README.
    nixpkgs.url = "github:NixOS/nixpkgs/e72e4f299401a3689d4b3d5fc6496b11db7064eb";
  };

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # The version package.json asks for, with any range prefix dropped. The
      # pin is exact today ("1.61.1"); this keeps working if that ever changes.
      playwrightPin =
        let
          spec = (lib.importJSON ./package.json).devDependencies."@playwright/test";
        in
        lib.removePrefix "^" (lib.removePrefix "~" spec);
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          # Only Linux needs this: on macOS the browsers Playwright downloads
          # run fine, and nixpkgs does not build the bundle for darwin.
          useNixBrowsers = pkgs.stdenv.hostPlatform.isLinux;

          driverVersion = pkgs.playwright-driver.version;

          # Only Chromium is configured in playwright.config.ts. Firefox and
          # WebKit would roughly triple the closure for nothing. The headless
          # shell stays: that is what a headless run actually launches.
          browsers = pkgs.playwright-driver.selectBrowsers {
            withFirefox = false;
            withWebkit = false;
          };

          # A mismatch here is worth shouting about: Playwright would otherwise
          # fail much later with an opaque "browser not found" during the e2e
          # run, pointing at the wrong thing entirely.
          checkVersions = lib.warnIf (
            useNixBrowsers && driverVersion != playwrightPin
          ) "bgpshark: nixpkgs playwright-driver is ${driverVersion} but package.json pins @playwright/test ${playwrightPin}; `bun run test:e2e` will not find a browser until they match";
        in
        {
          default = pkgs.mkShell {
            name = "bgpshark";

            packages =
              [
                pkgs.bun
                # Playwright's CLI and its own test runner shell out to node.
                pkgs.nodejs_22
              ]
              ++ lib.optional useNixBrowsers browsers;

            env = {
              # Stop `bun install` from fetching browsers that would not run
              # here anyway — and from trying to write them into the store.
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            }
            // lib.optionalAttrs useNixBrowsers {
              PLAYWRIGHT_BROWSERS_PATH = checkVersions "${browsers}";
              # The host check looks for distribution packages by name and does
              # not recognise a Nix system, so it reports missing dependencies
              # that are in fact present.
              PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
            };

            shellHook = ''
              echo "bgpshark dev shell — bun $(bun --version)${
                lib.optionalString useNixBrowsers ", playwright browsers ${driverVersion}"
              }"
              echo "  bun install && bun run dev    # http://localhost:5173/bgpshark/"
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
