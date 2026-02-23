import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: "module",
			},
		},
		plugins: {
			"@typescript-eslint": tseslint,
			prettier,
		},
		rules: {
			...tseslint.configs.recommended.rules,
			...prettierConfig.rules,
			"prettier/prettier": "error",
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/explicit-function-return-type": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-require-imports": "off",
			"no-console": ["warn", { allow: ["error", "log"] }],
		},
	},
	{
		files: ["media/webview/*.js"],
		plugins: {
			prettier,
		},
		rules: {
			...prettierConfig.rules,
			"prettier/prettier": "error",
			"no-var": "off",
		},
	},
	{
		ignores: ["dist/", "node_modules/", "media/xterm.min.js", "media/addon-fit.min.js"],
	},
];
