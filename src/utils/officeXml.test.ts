import { describe, expect, it } from 'vitest';
import { validateOfficeXmlComplexity } from '../hooks/editorResources';
import { MAX_OFFICE_XML_ELEMENTS } from './importValidation';

describe('Office XML preflight', () => {
    it('rejects DTD/entity declarations and oversized auxiliary parts', () => {
        expect(() => validateOfficeXmlComplexity('<!DOCTYPE x [<!ENTITY leak SYSTEM "https://example.com">]><x/>')).toThrow();
        expect(() => validateOfficeXmlComplexity('<style/>'.repeat(MAX_OFFICE_XML_ELEMENTS + 1))).toThrow();
        expect(() => validateOfficeXmlComplexity('<?xml version="1.0"?><styles><style/></styles>')).not.toThrow();
    });
});
