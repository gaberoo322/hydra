/**
 * Attribution.jsx — sprite-vendor credits for the /now-pixel page.
 *
 * Slice 1 of the /now-pixel epic (#642, child #643). This component is
 * not yet wired into a route — later slices import it as the footer of
 * the /now-pixel page.
 *
 * The Gen-1 Pokemon sprites come from PokeAPI/sprites (MIT). The Ash
 * and Professor Oak trainer sprites come from Seidi460/Sprites-Pokemon-
 * Trainers. None of the sprites are owned by this project; we credit
 * their sources here as a condition of vendoring. ash-blonde.png is
 * currently the canonical anime Ash sprite — a future PR may swap in a
 * blonde-mustache derivation; until then this filename is aspirational.
 */

export default function Attribution() {
  return (
    <footer
      style={{
        fontFamily: '"Press Start 2P", system-ui, sans-serif',
        fontSize: 10,
        lineHeight: 1.6,
        color: "#8a8a8a",
        padding: "8px 12px",
        borderTop: "1px solid #222",
      }}
    >
      <p style={{ margin: 0 }}>
        Pokemon &amp; trainer sprites are property of Nintendo / Game Freak /
        The Pokemon Company. Vendored here for fan use.
      </p>
      <p style={{ margin: "4px 0 0 0" }}>
        Gen-1 Pokemon sprites:{" "}
        <a
          href="https://github.com/PokeAPI/sprites"
          target="_blank"
          rel="noreferrer noopener"
        >
          PokeAPI/sprites
        </a>
        {" · "}
        Trainer sprites (Ash, Oak):{" "}
        <a
          href="https://github.com/Seidi460/Sprites-Pokemon-Trainers"
          target="_blank"
          rel="noreferrer noopener"
        >
          Seidi460/Sprites-Pokemon-Trainers
        </a>
      </p>
    </footer>
  );
}
