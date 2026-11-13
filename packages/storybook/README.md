# Component stories

`generateCatalog(packageDirectory)` scans exported React components under `src/` and writes `.storybook/generated/`: CSF stories and `catalog.json` for Studio. Repeating a scan leaves unchanged files untouched and removes stories whose component was removed.

A sibling `Button.meta.tsx` may export `meta: ComponentMeta<ButtonProps>` with `args`, named `examples`, model links and design-document paths. Metadata belongs to the component named by the file; other exports from the same file use their inferred props. Renderable values such as JSX stay in the generated story's import. The JSON catalog contains serializable values only.

Use `storybook(packageDirectory)` from this package as the default export in `.storybook/main.ts`. It configures React/Vite, accessibility checks, generated-file discovery and regeneration when component or metadata files change. Add `.storybook/generated/` to the application's ignore file. The application supplies Storybook, its React/Vite framework and accessibility addon.

The generator does not invent values for required callbacks or opaque object props. Provide an example for those props; the catalog reports missing examples. Domain transitions remain in the component's generated Machine service.
