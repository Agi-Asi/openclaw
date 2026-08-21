import Arborist from "@npmcli/arborist";
import packlist from "npm-packlist";

const packageDir = process.argv[2];
if (!packageDir) {
  throw new Error("package directory is required");
}

const tree = await new Arborist({ path: packageDir }).loadActual();
const files = await packlist(tree, { path: packageDir });
process.stdout.write(JSON.stringify(files));
