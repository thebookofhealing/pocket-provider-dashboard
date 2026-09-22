import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <a
        className="site-footer-brand"
        href="https://kleomedes.cloud/"
        target="_blank"
        rel="noopener noreferrer"
      >
        Pocket Network Analytics by Kleomedes
      </a>
      <nav aria-label="Secondary navigation">
        <Link href="/network">Check Dashboard Health</Link>
      </nav>
    </footer>
  );
}
