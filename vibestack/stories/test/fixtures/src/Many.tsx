type Shade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
type Hue = "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink";

export function Many({ shade, hue, dense }: { shade?: Shade; hue?: Hue; dense?: boolean }) {
  return <i data-shade={shade} data-hue={hue} data-dense={dense} />;
}
