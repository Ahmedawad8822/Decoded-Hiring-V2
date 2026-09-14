import Link from "next/link";

export default function NotFound() {
  return (
    <article className="hg-page is-active">
      <section className="hg-section hg-final">
        <p className="hg-kicker">Not found</p>
        <h1 className="hg-title">This page is not part of the system.</h1>
        <div className="hg-actions">
          <Link className="hg-primary" href="/">
            Back to the homepage
          </Link>
          <Link className="hg-secondary" href="/programmes">
            Explore programmes
          </Link>
        </div>
      </section>
    </article>
  );
}
