const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "ci", "refactor", "test", "docs", "chore", "perf", "style", "migration"],
    ],
    "header-max-length": [2, "always", 72],
    "subject-case": [0],
  },
};

export default config;
