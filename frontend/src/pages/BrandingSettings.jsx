import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { compressLogoFile } from "../utils/image";

export default function BrandingSettings() {
  const [logoData, setLogoData] = useState(null);
  const [companyName, setCompanyName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [company, setCompany] = useState({
    invoice_company_name: "",
    company_address: "",
    company_tin: "",
    company_phone: "",
    company_email: "",
    company_website: "",
    payment_instructions: "",
    payment_instructions_usd: "",
    swift_code: "",
    invoice_footer: "",
    invoice_email_subject: "",
    invoice_email_body: "",
  });
  const [emailDefaults, setEmailDefaults] = useState(null);
  const [savingCompany, setSavingCompany] = useState(false);
  const [invoiceLogo, setInvoiceLogo] = useState(null);
  const invoiceFileRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef(null);

  const load = () => {
    setLoading(true);
    api
      .get("/branding/company")
      .then((data) => {
        setLogoData(data.logo_data);
        setCompanyName(data.company_name || "");
        setInvoiceLogo(data.invoice_logo_data || null);
        setCompany({
          invoice_company_name: data.invoice_company_name || "",
          company_address: data.company_address || "",
          company_tin: data.company_tin || "",
          company_phone: data.company_phone || "",
          company_email: data.company_email || "",
          company_website: data.company_website || "",
          payment_instructions: data.payment_instructions || "",
          payment_instructions_usd: data.payment_instructions_usd || "",
          swift_code: data.swift_code || "",
          invoice_footer: data.invoice_footer || "",
          invoice_email_subject: data.invoice_email_subject || "",
          invoice_email_body: data.invoice_email_body || "",
        });
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // The wording the app falls back to, and the fields a template may use, come
  // from the server so this page cannot describe something different.
  useEffect(() => {
    api.get("/branding/invoice-email-defaults").then(setEmailDefaults).catch(() => {});
  }, []);

  const save = async (newLogoData) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await api.put("/branding", { logo_data: newLogoData, company_name: companyName });
      setLogoData(data.logo_data);
      setSaved(true);
      // Tell the sidebar header (Layout.jsx) to re-fetch so it swaps to the
      // new logo right away rather than after the next full page load.
      window.dispatchEvent(new Event("branding-updated"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const compressed = await compressLogoFile(file);
      await save(compressed);
    } catch (err) {
      setError(err.message);
    }
  };

  const onInvoiceFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const compressed = await compressLogoFile(file);
      setInvoiceLogo(compressed);
      const data = await api.put("/branding", {
        logo_data: logoData,
        invoice_logo_data: compressed,
        ...company,
      });
      setInvoiceLogo(data.invoice_logo_data || null);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Branding</h1>
          <p className="subtitle">
            Two identities: the one this application wears, and the company that issues your invoices
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {saved && <div className="success-banner">Saved.</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Company name</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          Used wherever the application names the company — the sign-in screen, the sidebar, notification emails and
          the author field of every exported spreadsheet.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="MARCA GROUP"
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            type="button"
            className="btn"
            disabled={savingName || !companyName.trim()}
            onClick={async () => {
              setSavingName(true);
              setError("");
              setSaved(false);
              try {
                // Sends the logo unchanged alongside it — the endpoint takes
                // both together, and omitting the logo would clear it.
                const data = await api.put("/branding", { logo_data: logoData, company_name: companyName.trim() });
                setCompanyName(data.company_name || "");
                setSaved(true);
                window.dispatchEvent(new Event("branding-updated"));
              } catch (err) {
                setError(err.message);
              } finally {
                setSavingName(false);
              }
            }}
          >
            {savingName ? "Saving…" : "Save name"}
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="page-loading">Loading…</div>
        ) : (
          <>
            <p className="subtitle" style={{ margin: "0 0 12px" }}>
              PNG or JPG recommended, square, at least 120×120px. Falls back to the default "M" mark when no logo is set.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  background: "var(--surface-alt, var(--surface))",
                  flexShrink: 0,
                }}
              >
                {logoData ? (
                  <img src={logoData} alt="Current logo" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                ) : (
                  <span className="brand-mark" style={{ width: 44, height: 44, fontSize: 20 }}>M</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" className="btn" disabled={saving} onClick={() => fileInputRef.current?.click()}>
                  {saving ? "Uploading…" : "Upload logo"}
                </button>
                {logoData && (
                  <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => save(null)}>
                    Remove logo
                  </button>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display: "none" }} />
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Company details for invoices</h2>
        <p className="subtitle">
          The identity your customers see. Nothing here is shown on the sign-in screen, which is reachable by anyone
          with the address — so the company that issues your invoices need not be the name on that page. Leave a field
          blank to keep it off the document.
        </p>

        <div className="form-row">
          <label>Invoicing company name</label>
          <input
            value={company.invoice_company_name}
            placeholder={companyName || "Same as the application name"}
            onChange={(e) => setCompany({ ...company, invoice_company_name: e.target.value })}
          />
          <span className="subtitle" style={{ fontSize: 12, display: "block" }}>
            Printed at the top of every invoice and used to sign the emails that carry them. Leave blank to reuse the
            application name above.
          </span>
        </div>

        <div className="form-row">
          <label>Invoice logo</label>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <div
              style={{
                width: 110,
                height: 56,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid var(--border)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {invoiceLogo ? (
                <img src={invoiceLogo} alt="Invoice logo" style={{ maxWidth: "100%", maxHeight: "100%" }} />
              ) : (
                <span className="subtitle" style={{ fontSize: 11, margin: 0, textAlign: "center" }}>
                  using the
                  <br />
                  app logo
                </span>
              )}
            </div>
            <button type="button" className="btn btn-sm" onClick={() => invoiceFileRef.current?.click()}>
              Upload invoice logo
            </button>
            {invoiceLogo && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={async () => {
                  setError("");
                  try {
                    const data = await api.put("/branding", {
                      logo_data: logoData,
                      invoice_logo_data: null,
                      ...company,
                    });
                    setInvoiceLogo(data.invoice_logo_data || null);
                  } catch (err) {
                    setError(err.message);
                  }
                }}
              >
                Remove
              </button>
            )}
          </div>
          <span className="subtitle" style={{ fontSize: 12, display: "block" }}>
            PNG or JPG. Appears on the invoice PDF only. Falls back to the application logo when none is set.
          </span>
          <input
            ref={invoiceFileRef}
            type="file"
            accept="image/png,image/jpeg"
            onChange={onInvoiceFileChange}
            style={{ display: "none" }}
          />
        </div>

        <div className="form-row">
          <label>Registered address</label>
          <textarea
            rows={2}
            value={company.company_address}
            placeholder="Unit 1, Example Building, Taguig City, Metro Manila"
            onChange={(e) => setCompany({ ...company, company_address: e.target.value })}
          />
        </div>

        <div className="grid grid-2">
          <div className="form-row">
            <label>TIN</label>
            <input
              value={company.company_tin}
              placeholder="000-000-000-000"
              onChange={(e) => setCompany({ ...company, company_tin: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>Phone</label>
            <input
              value={company.company_phone}
              onChange={(e) => setCompany({ ...company, company_phone: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>Email</label>
            <input
              type="email"
              value={company.company_email}
              onChange={(e) => setCompany({ ...company, company_email: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>Website</label>
            <input
              value={company.company_website}
              onChange={(e) => setCompany({ ...company, company_website: e.target.value })}
            />
          </div>
        </div>

        <div className="form-row">
          <label>Peso account</label>
          <textarea
            rows={3}
            value={company.payment_instructions}
            placeholder="Bank / account name / account number"
            onChange={(e) => setCompany({ ...company, payment_instructions: e.target.value })}
          />
          <span className="subtitle" style={{ fontSize: 12 }}>
            Printed on every invoice so local customers know where to pay.
          </span>
        </div>

        <div className="form-row">
          <label>US dollar account (international clients)</label>
          <textarea
            rows={3}
            value={company.payment_instructions_usd}
            placeholder="Bank / account name / account number / correspondent bank"
            onChange={(e) => setCompany({ ...company, payment_instructions_usd: e.target.value })}
          />
        </div>

        <div className="form-row">
          <label>SWIFT / BIC code</label>
          <input
            value={company.swift_code}
            placeholder="BOPIPHMM"
            style={{ textTransform: "uppercase", maxWidth: 220 }}
            onChange={(e) => setCompany({ ...company, swift_code: e.target.value.toUpperCase() })}
          />
          <span className="subtitle" style={{ fontSize: 12, display: "block" }}>
            Eight or eleven characters. Printed with the dollar account so an overseas client&apos;s bank can route the
            transfer.
          </span>
        </div>

        <div className="form-row">
          <label>Invoice footer</label>
          <input
            value={company.invoice_footer}
            placeholder="Thank you for your business."
            onChange={(e) => setCompany({ ...company, invoice_footer: e.target.value })}
          />
        </div>


        <div className="form-row" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <label>Invoice email subject</label>
          <input
            value={company.invoice_email_subject}
            placeholder={emailDefaults?.subject || ""}
            onChange={(e) => setCompany({ ...company, invoice_email_subject: e.target.value })}
          />
        </div>

        <div className="form-row">
          <label>Invoice email message</label>
          <textarea
            rows={14}
            value={company.invoice_email_body}
            placeholder={emailDefaults?.body || ""}
            style={{ fontFamily: "inherit", lineHeight: 1.5 }}
            onChange={(e) => setCompany({ ...company, invoice_email_body: e.target.value })}
          />
          <span className="subtitle" style={{ fontSize: 12, display: "block" }}>
            The covering note the invoice PDF is attached to. Leave either field blank to use the standard wording shown
            in grey.
          </span>
        </div>

        {emailDefaults?.placeholders && (
          <div className="form-row">
            <span className="subtitle" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
              These are replaced when the email is sent:
            </span>
            <table className="sticky-head">
              <tbody>
                {emailDefaults.placeholders.map(([token, meaning]) => (
                  <tr key={token}>
                    <td style={{ width: 160, fontFamily: "monospace" }}>{token}</td>
                    <td className="subtitle" style={{ margin: 0 }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {company.invoice_email_body.trim() !== "" && emailDefaults?.body && (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            style={{ marginBottom: 12 }}
            onClick={() => setCompany({ ...company, invoice_email_subject: "", invoice_email_body: "" })}
          >
            Reset to the standard wording
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={savingCompany}
          onClick={async () => {
            setSavingCompany(true);
            setError("");
            setSaved(false);
            try {
              // The logo goes along unchanged — the endpoint takes it on every
              // call and leaving it out would clear it.
              const data = await api.put("/branding", {
                logo_data: logoData,
                invoice_logo_data: invoiceLogo,
                ...company,
              });
              setInvoiceLogo(data.invoice_logo_data || null);
              setCompany({
                invoice_company_name: data.invoice_company_name || "",
                company_address: data.company_address || "",
                company_tin: data.company_tin || "",
                company_phone: data.company_phone || "",
                company_email: data.company_email || "",
                company_website: data.company_website || "",
                payment_instructions: data.payment_instructions || "",
                payment_instructions_usd: data.payment_instructions_usd || "",
                swift_code: data.swift_code || "",
                invoice_footer: data.invoice_footer || "",
          invoice_email_subject: data.invoice_email_subject || "",
          invoice_email_body: data.invoice_email_body || "",
              });
              setSaved(true);
            } catch (err) {
              setError(err.message);
            } finally {
              setSavingCompany(false);
            }
          }}
        >
          {savingCompany ? "Saving…" : "Save company details"}
        </button>
      </div>
    </div>
  );
}
