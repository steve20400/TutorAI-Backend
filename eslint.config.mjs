import js from "@eslint/js"
import tseslint from "typescript-eslint"

/**
 * Le même linter court que côté WEB, sans React.
 *
 * Ici la règle `no-floating-promises` pèse plus lourd qu'ailleurs : une
 * écriture en base qu'on lance sans attendre rend 200 à l'appelant pendant
 * que la transaction échoue derrière. C'est la panne qu'on ne voit jamais
 * dans les journaux parce que personne ne s'est plaint.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Les fichiers de configuration et les tests ne sont pas dans le tsconfig
  // — celui-ci ne décrit que ce qui part dans `dist/`. Les soumettre au
  // parseur typé donne une erreur d'analyse, pas une règle violée.
  {
    files: ["**/*.mjs", "**/*.js", "tests/**"],
    ...tseslint.configs.disableTypeChecked,
  },
)
