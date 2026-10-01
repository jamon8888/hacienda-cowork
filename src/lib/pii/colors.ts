const PII_COLORS: Record<string, { light: string; dark: string; label: string }> = {
  email:               { light: '#3b82f6', dark: '#60a5fa', label: 'Email' },
  person_full_name:    { light: '#10b981', dark: '#34d399', label: 'Name' },
  person_first_name:   { light: '#84cc16', dark: '#a3e635', label: 'First Name' },
  person_last_name:    { light: '#f59e0b', dark: '#fbbf24', label: 'Last Name' },
  date_of_birth:       { light: '#ef4444', dark: '#f87171', label: 'Date of Birth' },
  phone_number:        { light: '#8b5cf6', dark: '#a78bfa', label: 'Phone' },
  address:             { light: '#ec4899', dark: '#f472b6', label: 'Address' },
  city:                { light: '#8b5cf6', dark: '#a78bfa', label: 'City' },
  postal_code:         { light: '#a855f6', dark: '#c084fc', label: 'Postal Code' },
  ip_address:          { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  ipv4:                { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  ipv6:                { light: '#6366f1', dark: '#818cf8', label: 'IP' },
  credit_card:         { light: '#f59e0b', dark: '#fbbf24', label: 'Card' },
  iban:                { light: '#ef4444', dark: '#f87171', label: 'IBAN' },
  amount:              { light: '#14b8a6', dark: '#2dd4bf', label: 'Amount' },
  bank_account:        { light: '#f59e0b', dark: '#fbbf24', label: 'Bank Account' },
  organization:        { light: '#06b6d4', dark: '#22d3ee', label: 'Org' },
  location:            { light: '#0891b2', dark: '#0891b2', label: 'Location' },
  national_id_fr:      { light: '#f97316', dark: '#fb923c', label: 'National ID (FR)' },
  national_id_nl:      { light: '#f97316', dark: '#fb923c', label: 'National ID (NL)' },
  national_id_be:      { light: '#f97316', dark: '#fb923c', label: 'National ID (BE)' },
  national_id_at:      { light: '#f97316', dark: '#fb923c', label: 'National ID (AT)' },
  national_id_ie:      { light: '#f97316', dark: '#fb923c', label: 'National ID (IE)' },
  national_id_pt:      { light: '#f97316', dark: '#fb923c', label: 'National ID (PT)' },
  aws_access_key:      { light: '#7f1d1f', dark: '#b91c1c', label: 'AWS Access Key' },
  aws_secret_key:      { light: '#7f1d1f', dark: '#b91c1c', label: 'AWS Secret Key' },
  gcp_credentials:     { light: '#7f1d1f', dark: '#b91c1c', label: 'GCP Credentials' },
  azure_credentials:   { light: '#7f1d1f', dark: '#b91c1c', label: 'Azure Credentials' },
  api_key:             { light: '#7f1d1f', dark: '#b91c1c', label: 'API Key' },
  jwt_token:           { light: '#7f1d1f', dark: '#b91c1c', label: 'JWT Token' },
  bearer_token:        { light: '#7f1d1f', dark: '#b91c1c', label: 'Bearer Token' },
  oauth_token:         { light: '#7f1d1f', dark: '#b91c1c', label: 'OAuth Token' },
  ssh_private_key:     { light: '#7f1d1f', dark: '#b91c1c', label: 'SSH Private Key' },
  gpg_private_key:     { light: '#7f1d1f', dark: '#b91c1c', label: 'GPG Private Key' },
  tls_certificate:     { light: '#7f1d1f', dark: '#b91c1c', label: 'TLS Certificate' },
  db_connection_string:{ light: '#7f1d1f', dark: '#b91c1c', label: 'DB Connection String' },
  env_secret:          { light: '#7f1d1f', dark: '#b91c1c', label: 'Env Secret' },
  internal_hostname:   { light: '#a21caf', dark: '#e9e5ff', label: 'Internal Hostname' },
  internal_url:        { light: '#a21caf', dark: '#e9e5ff', label: 'Internal URL' },
  mac_address:         { light: '#d1d5db', dark: '#4b5563', label: 'MAC Address' },
  cookie_id:           { light: '#d1d5db', dark: '#4b5563', label: 'Cookie ID' },

  // GLiNER2 PII labels with no existing home (basemind's 42-label set).
  // Labels that already have one fold through CATEGORY_ALIASES instead.
  middle_name:         { light: '#84cc16', dark: '#a3e635', label: 'Middle Name' },
  state_or_region:     { light: '#8b5cf6', dark: '#a78bfa', label: 'State or Region' },
  country:             { light: '#0891b2', dark: '#0891b2', label: 'Country' },
  government_id:       { light: '#f97316', dark: '#fb923c', label: 'Government ID' },
  national_id_number:  { light: '#f97316', dark: '#fb923c', label: 'National ID' },
  passport_number:     { light: '#f97316', dark: '#fb923c', label: 'Passport Number' },
  drivers_license_number: { light: '#f97316', dark: '#fb923c', label: "Driver's License" },
  license_number:      { light: '#f97316', dark: '#fb923c', label: 'License Number' },
  tax_id:              { light: '#f97316', dark: '#fb923c', label: 'Tax ID' },
  tax_number:          { light: '#f97316', dark: '#fb923c', label: 'Tax Number' },
  account_number:      { light: '#f59e0b', dark: '#fbbf24', label: 'Account Number' },
  routing_number:      { light: '#f59e0b', dark: '#fbbf24', label: 'Routing Number' },
  card_expiry:         { light: '#f59e0b', dark: '#fbbf24', label: 'Card Expiry' },
  card_cvv:            { light: '#f59e0b', dark: '#fbbf24', label: 'Card CVV' },
  username:            { light: '#6366f1', dark: '#818cf8', label: 'Username' },
  account_id:          { light: '#6366f1', dark: '#818cf8', label: 'Account ID' },
  sensitive_account_id:{ light: '#6366f1', dark: '#818cf8', label: 'Sensitive Account ID' },
  password:            { light: '#7f1d1f', dark: '#b91c1c', label: 'Password' },
  secret:              { light: '#7f1d1f', dark: '#b91c1c', label: 'Secret' },
  recovery_code:       { light: '#7f1d1f', dark: '#b91c1c', label: 'Recovery Code' },
  sensitive_date:      { light: '#ef4444', dark: '#f87171', label: 'Sensitive Date' },
  document_date:       { light: '#ef4444', dark: '#f87171', label: 'Document Date' },
  expiration_date:     { light: '#ef4444', dark: '#f87171', label: 'Expiration Date' },
  transaction_date:    { light: '#ef4444', dark: '#f87171', label: 'Transaction Date' },

  // EU AI Act terms (zero-shot GLiNER labels + the citation regex).
  ai_act_provider:     { light: '#0d9488', dark: '#2dd4bf', label: 'AI Act Provider' },
  ai_act_deployer:     { light: '#0d9488', dark: '#2dd4bf', label: 'AI Act Deployer' },
  ai_act_importer:     { light: '#0d9488', dark: '#2dd4bf', label: 'AI Act Importer' },
  ai_act_distributor:  { light: '#0d9488', dark: '#2dd4bf', label: 'AI Act Distributor' },
  ai_act_notified_body: { light: '#0d9488', dark: '#2dd4bf', label: 'Notified Body' },
  ai_act_authorised_representative: { light: '#0d9488', dark: '#2dd4bf', label: 'Authorised Representative' },
  high_risk_ai_system: { light: '#0d9488', dark: '#2dd4bf', label: 'High-Risk AI System' },
  gpai_model:          { light: '#0d9488', dark: '#2dd4bf', label: 'GPAI Model' },
  ai_act_systemic_risk:{ light: '#0d9488', dark: '#2dd4bf', label: 'Systemic Risk' },
  ai_act_conformity_assessment: { light: '#0d9488', dark: '#2dd4bf', label: 'Conformity Assessment' },
  ai_act_technical_documentation: { light: '#0d9488', dark: '#2dd4bf', label: 'Technical Documentation' },
  ai_act_market_surveillance: { light: '#0d9488', dark: '#2dd4bf', label: 'Market Surveillance' },
  ai_act_penalty:      { light: '#0d9488', dark: '#2dd4bf', label: 'AI Act Penalty' },
  ai_act_citation:     { light: '#0d9488', dark: '#2dd4bf', label: 'AI Act Citation' },
};

export { PII_COLORS };

export function getPiiColor(category: string): { light: string; dark: string } {
  // `category` reaches here from detector output, so it can name an inherited
  // member such as `toString` or `constructor`. Those read back truthy and
  // would skip the fallback, handing the caller a function instead of a colour.
  if (!Object.prototype.hasOwnProperty.call(PII_COLORS, category)) {
    return { light: '#6b7280', dark: '#4b5563' };
  }
  return PII_COLORS[category];
}

export default PII_COLORS;