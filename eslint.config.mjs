import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  { rules: { "react-hooks/purity": "off" } },
];
export default config;
