# Fixed original-subject producer packaging

The runtime build compiles TypeScript, copies the diagnostic controller, then
runs `scripts/build-pure-producer.mjs`. That last step builds the fixed pure
assertion producer once using the installed build toolchain. It writes:

- `dist/repository-pure-assets/implementation.json`: the canonical descriptor.
- The fixed `producer.mjs` and two parser/grammar Wasm assets in that directory.
- Digest-addressed compiler and virtual-facade provenance bytes under its
  `provenance` directory. These bytes are verified, never executed at startup.
- `dist/repository-pure-assets-pin.js`: a generated trusted-code constant binding
  the descriptor digest. The source stub remains null and is not modified.

`loadRepositoryPureProducerAssetsSync()` loads only this fixed installation
location. It checks the generated pin, closed descriptor, exact installed
inventory, every asset hash, and current runtime/core/protocol/parser dependency
bytes. It also checks the shipped build provenance without loading the compiler.
Only then does it mint the private assets object used by physical execution and
independent replay. Missing, changed or extra files fail closed. A rehashed
artifact cannot supply a replacement trusted pin.

Production requires the runtime's declared production dependencies, installed
compiled modules, the generated pin, and the complete asset directory. It does
not require `tsx`, TypeScript or esbuild after build. These development tools
must be present when producing a new installation. The fixed bundle and
provenance are portable bytes; the build platform remains disclosed in the
compiler identity.

`repositoryPureProducerAssetsForCurrentBuild()` chooses this synchronous loader
for compiled JavaScript and the explicit asynchronous builder for source tools.
Source execution and compiled execution keep distinct implementation identities.
There is no source-mode fallback from a missing packaged installation.

The package mounted into OCI contains the three fixed execution assets, the
request, and digest-addressed captured data. Compiler provenance is installation
metadata and is not mounted into the producer sandbox. Submitted JavaScript is
read as data and cannot select modules, paths, compiler flags or package scripts.

The packaging tests stage compiled modules in a private temporary directory,
install only production dependencies, verify successful synchronous loading,
and reject rehashed package substitutions, parser/runtime dependency drift,
missing provenance and extra inventory. They do not rebuild workspace `dist`.
