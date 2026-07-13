{
  description = "mnemosyne — extract → route → dispatch session learnings CLI";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        nodejs = pkgs.nodejs_24;
        # lockfileVersion 9.0 + packageManager pnpm@11.x → default pnpm (major 11).
        pnpm = pkgs.pnpm;
      in
      {
        packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "mnemosyne";
          version = "0.1.0";
          src = ./.;

          nativeBuildInputs = [
            nodejs
            pnpm.configHook
            pkgs.makeWrapper
          ];

          pnpmDeps = pnpm.fetchDeps {
            inherit (finalAttrs) pname version src;
            fetcherVersion = 3;
            hash = "sha256-zJ2MQhe5wLY7Y8B09BW+ybYQmw6AZ38x7VZWbMqndOM=";
          };

          buildPhase = ''
            runHook preBuild
            pnpm build
            runHook postBuild
          '';

          # No runtime dependencies (package.json has devDependencies only), so
          # the built dist/ runs on plain node — we ship node + dist, no node_modules.
          installPhase = ''
            runHook preInstall
            mkdir -p "$out/lib/mnemosyne"
            cp -r dist "$out/lib/mnemosyne/"
            cp package.json "$out/lib/mnemosyne/"
            makeWrapper "${nodejs}/bin/node" "$out/bin/mnemosyne" \
              --add-flags "$out/lib/mnemosyne/dist/cli.js"
            runHook postInstall
          '';

          meta = {
            description = "mnemosyne — extract → route → dispatch session learnings CLI";
            mainProgram = "mnemosyne";
            platforms = pkgs.lib.platforms.unix;
          };
        });

        apps.default = flake-utils.lib.mkApp {
          drv = self.packages.${system}.default;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pnpm
          ];
        };
      }
    );
}
