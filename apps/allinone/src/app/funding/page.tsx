import Link from "next/link";
import FundingClient from "./funding-client";
import "./funding.css";

export const metadata = { title: "券商入金 · AllInOne" };
export default function FundingPage() {
  return (
    <main className="funding">
      <Link href="/" className="fund-back">
        ← 返回工具箱
      </Link>
      <FundingClient />
    </main>
  );
}
