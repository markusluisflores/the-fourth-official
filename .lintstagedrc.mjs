// tsc must ignore the filenames lint-staged appends: passing explicit files to `tsc`
// disables its tsconfig.json auto-discovery (jsx, moduleResolution, target, etc. get
// dropped), so it's wrapped in a function that always runs the fixed, project-wide command.
const config = {
  "*.{ts,tsx}": ["prettier --write", "eslint --fix", () => "tsc --noEmit"],
};

export default config;
