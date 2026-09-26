// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Internationalization/Culture.h"
#include "Internationalization/Internationalization.h"
#include "Internationalization/Text.h"
#include "LocHubGlyphChecker.h"
#include "LocHubSnapshot.h"
#include "LocHubTypes.h"
#include "LocHubValidator.h"
#include "Misc/AutomationTest.h"
#include "Misc/Paths.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace LocHubValidatorTestsPrivate
{
	/** "{Count}|plural(one=x,other=x)" with exactly the given forms. */
	FString PluralPattern(const TArray<FString>& InForms)
	{
		TArray<FString> FormParts;
		for (const FString& Form : InForms)
		{
			FormParts.Add(Form + TEXT("=x"));
		}
		return FString::Printf(TEXT("{Count}|plural(%s)"), *FString::Join(FormParts, TEXT(",")));
	}

	bool AnyContains(const TArray<FString>& InErrors, const TCHAR* InNeedle)
	{
		for (const FString& Error : InErrors)
		{
			if (Error.Contains(InNeedle, ESearchCase::CaseSensitive))
			{
				return true;
			}
		}
		return false;
	}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubValidatorEnginePatternsTest,
	"LocHub.Validator.EnginePatterns",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubValidatorEnginePatternsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubValidatorTestsPrivate;

	const FCulturePtr Ru = FInternationalization::Get().GetCulture(TEXT("ru"));
	if (!TestTrue(TEXT("Culture ru exists"), Ru.IsValid()))
	{
		return false;
	}

	TArray<FString> Errors;
	TestTrue(TEXT("Plain text passes"), LocHubValidator::Validate(TEXT("ru"), TEXT("Pause"), TEXT("Pause RU"), nullptr, Errors));
	TestEqual(TEXT("Plain text has no errors"), Errors.Num(), 0);

	Errors.Reset();
	TestFalse(TEXT("Empty translation is rejected"), LocHubValidator::Validate(TEXT("ru"), TEXT("Pause"), FString(), nullptr, Errors));

	// The pattern carries exactly the plural forms the engine reports for ru, so the test holds whatever CLDR says.
	const FString Source = TEXT("{Count}|plural(one=bale,other=bales)");
	FLocHubPluralForms RuForms;
	if (TestTrue(TEXT("The engine reports the ru plural forms"), LocHubSnapshot::GetEnginePluralForms(TEXT("ru"), RuForms)))
	{
		Errors.Reset();
		TestTrue(TEXT("Every plural form of the culture passes"), LocHubValidator::Validate(TEXT("ru"), Source, PluralPattern(RuForms.Cardinal), nullptr, Errors));
		TestEqual(TEXT("Full plural has no errors"), Errors.Num(), 0);

		Errors.Reset();
		const bool bOneOtherPasses = LocHubValidator::Validate(TEXT("ru"), Source, TEXT("{Count}|plural(one=x,other=y)"), nullptr, Errors);
		if (RuForms.Cardinal.Num() > 2)
		{
			TestFalse(TEXT("Missing plural forms are rejected"), bOneOtherPasses);
			TestTrue(TEXT("The engine error is prefixed"), AnyContains(Errors, TEXT("Format pattern: ")));
		}
		else
		{
			AddInfo(TEXT("Culture ru reports two plural forms or fewer; the missing-form case does not apply."));
		}
	}

	// Unreal formats a pattern that leaves an argument out (a count the phrase does not need, a gender the language
	// does not have), so Pull does not refuse it; the service asks a human to confirm it instead.
	Errors.Reset();
	TestTrue(TEXT("A dropped argument is accepted"), LocHubValidator::Validate(TEXT("ru"), TEXT("{Count} bales"), TEXT("bales RU"), nullptr, Errors));
	TestEqual(TEXT("A dropped argument has no errors"), Errors.Num(), 0);

	// An argument the source does not provide is printed as "{Extra}" at runtime.
	Errors.Reset();
	TestFalse(TEXT("Extra argument is rejected"), LocHubValidator::Validate(TEXT("ru"), TEXT("{Count} bales"), TEXT("{Count} bales RU {Extra}"), nullptr, Errors));
	TestTrue(TEXT("The extra argument is named"), AnyContains(Errors, TEXT("{Extra}")));

	Errors.Reset();
	TestFalse(TEXT("Argument names are case-sensitive"), LocHubValidator::Validate(TEXT("ru"), TEXT("{Count} bales"), TEXT("{count} bales RU"), nullptr, Errors));

	// A modifier that opens the text follows no argument and does not compile (FTextFormatData::Compile_NoLock,
	// "Unexpected 'argument modifier' token").
	Errors.Reset();
	TestFalse(TEXT("A leading modifier is rejected"), LocHubValidator::Validate(TEXT("ru"), TEXT("{Count} bales"), TEXT("|plural(one=a,other=b) {Count} RU"), nullptr, Errors));
	TestTrue(TEXT("The compile error is prefixed"), AnyContains(Errors, TEXT("Format pattern: ")));

	// The engine's own boundary, pinned: an unmatched brace and a modifier after plain text are literal text to
	// FTextFormat (only '{' and '`' end a literal run), and a plural form name outside the CLDR set is skipped when the
	// modifier compiles (FTextFormatArgumentModifier_PluralForm), so none of them fails ValidatePattern. The service
	// still flags the first two (they print as raw text) and asks a human to confirm the third.
	Errors.Reset();
	TestTrue(TEXT("An unclosed brace is literal text to the engine"), LocHubValidator::Validate(TEXT("ru"), TEXT("{Count} bales"), TEXT("{Count bales RU"), nullptr, Errors));
	Errors.Reset();
	TestTrue(TEXT("A modifier after plain text is literal text to the engine"), LocHubValidator::Validate(TEXT("ru"), TEXT("{Count} bales"), TEXT("{Count} bales RU |plural(one=a,other=b)"), nullptr, Errors));
	Errors.Reset();
	TestTrue(TEXT("An unknown plural form name is ignored by the engine"), LocHubValidator::Validate(TEXT("en"), Source, TEXT("{Count}|plural(one=x,other=y,several=z)"), nullptr, Errors));
	TestEqual(TEXT("An unknown plural form name has no errors"), Errors.Num(), 0);

	// A modifier with no argument before it does not compile; such a source is not checked, or it could never pass.
	const FString BrokenSource = TEXT("|plural(one=a,other=b) left");
	if (TestTrue(TEXT("Fixture source does not compile"), FTextFormat::FromString(BrokenSource).GetExpressionType() == FTextFormat::EExpressionType::Invalid))
	{
		Errors.Reset();
		TestTrue(TEXT("Broken source is not checked"), LocHubValidator::Validate(TEXT("ru"), BrokenSource, TEXT("|plural(one=a,other=b) left RU"), nullptr, Errors));
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubValidatorSinglePluralFormCultureTest,
	"LocHub.Validator.SinglePluralFormCulture",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubValidatorSinglePluralFormCultureTest::RunTest(const FString& Parameters)
{
	// ja has a single cardinal plural form ("other"): the engine rejects a |plural modifier there
	// (FTextFormatArgumentModifier_PluralForm::Validate, TextFormatArgumentModifier.cpp:210, identical in
	// UE 5.6/5.7/5.8), so a LocHub translation must drop the modifier instead of keeping it, unlike a
	// multi-form culture such as en.
	const FCulturePtr Ja = FInternationalization::Get().GetCulture(TEXT("ja"));
	if (!Ja.IsValid())
	{
		AddInfo(TEXT("Culture ja is not available in this test environment (no ICU data): skipping the single-plural-form case."));
		return true;
	}

	const FString Source = TEXT("{Count}|plural(one=You have {Count} item,other=You have {Count} items)");

	TArray<FString> Errors;
	TestFalse(TEXT("ja rejects the plural modifier (single plural form)"), LocHubValidator::Validate(TEXT("ja"), Source, TEXT("{Count}|plural(other={Count}個)"), nullptr, Errors));

	Errors.Reset();
	TestTrue(TEXT("ja accepts the argument without the modifier"), LocHubValidator::Validate(TEXT("ja"), Source, TEXT("{Count}個のアイテムがあります"), nullptr, Errors));
	TestEqual(TEXT("No errors for the modifier-free ja translation"), Errors.Num(), 0);

	Errors.Reset();
	TestTrue(TEXT("en (several plural forms) still accepts the plural modifier"), LocHubValidator::Validate(TEXT("en"), Source, TEXT("{Count}|plural(one={Count} item,other={Count} items)"), nullptr, Errors));
	TestEqual(TEXT("No errors for the en plural translation"), Errors.Num(), 0);

	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubValidatorEnginePluralFormsTest,
	"LocHub.Validator.EnginePluralForms",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubValidatorEnginePluralFormsTest::RunTest(const FString& Parameters)
{
	using namespace LocHubValidatorTestsPrivate;

	TestEqual(TEXT("zero"), LocHubSnapshot::PluralFormName(ETextPluralForm::Zero), TEXT("zero"));
	TestEqual(TEXT("one"), LocHubSnapshot::PluralFormName(ETextPluralForm::One), TEXT("one"));
	TestEqual(TEXT("two"), LocHubSnapshot::PluralFormName(ETextPluralForm::Two), TEXT("two"));
	TestEqual(TEXT("few"), LocHubSnapshot::PluralFormName(ETextPluralForm::Few), TEXT("few"));
	TestEqual(TEXT("many"), LocHubSnapshot::PluralFormName(ETextPluralForm::Many), TEXT("many"));
	TestEqual(TEXT("other"), LocHubSnapshot::PluralFormName(ETextPluralForm::Other), TEXT("other"));

	// What the engine's own ICU data says (UE 5.8 ships ICU 64). Node's newer CLDR adds "many" to the fr cardinal set;
	// the engine validates on Pull, so LocHub sends these forms with every Push (Service/CONTRACT.md, pluralForms).
	struct FExpectedForms
	{
		const TCHAR* Culture;
		bool bCardinal;
		const TCHAR* Forms;
	};
	const FExpectedForms Cases[] = {
		{ TEXT("fr"), true, TEXT("one,other") },
		{ TEXT("it"), false, TEXT("many,other") },
		{ TEXT("de"), false, TEXT("other") },
		{ TEXT("ja"), true, TEXT("other") },
		{ TEXT("en"), false, TEXT("one,two,few,other") },
		{ TEXT("ru"), true, TEXT("one,few,many,other") },
	};
	for (const FExpectedForms& Case : Cases)
	{
		const FString What = FString::Printf(TEXT("%s %s"), Case.Culture, Case.bCardinal ? TEXT("cardinal") : TEXT("ordinal"));
		if (!FInternationalization::Get().GetCulture(Case.Culture).IsValid())
		{
			AddInfo(FString::Printf(TEXT("Culture %s is not available in this test environment (no ICU data): skipped."), Case.Culture));
			continue;
		}
		FLocHubPluralForms Forms;
		if (TestTrue(What + TEXT(" resolves"), LocHubSnapshot::GetEnginePluralForms(Case.Culture, Forms)))
		{
			TestEqual(*What, FString::Join(Case.bCardinal ? Forms.Cardinal : Forms.Ordinal, TEXT(",")), FString(Case.Forms));
		}
	}

	FLocHubPluralForms Unknown;
	TestFalse(TEXT("A culture the engine cannot resolve is left out"), LocHubSnapshot::GetEnginePluralForms(TEXT("xx-Nowhere"), Unknown));

	// The engine rejects a form the culture does not use ("has an unused plural form"), so a translation that follows
	// Node's CLDR instead of the engine's can never ship.
	FLocHubPluralForms Fr;
	if (!FInternationalization::Get().GetCulture(TEXT("fr")).IsValid() || !TestTrue(TEXT("fr resolves"), LocHubSnapshot::GetEnginePluralForms(TEXT("fr"), Fr)))
	{
		return true;
	}
	const FString Source = TEXT("{Count}|plural(one=bale,other=bales)");
	TArray<FString> Errors;
	TestTrue(TEXT("fr accepts exactly its engine forms"), LocHubValidator::Validate(TEXT("fr"), Source, PluralPattern(Fr.Cardinal), nullptr, Errors));
	TestEqual(TEXT("No errors for the engine forms"), Errors.Num(), 0);

	const TCHAR* const Candidates[] = { TEXT("many"), TEXT("few"), TEXT("two"), TEXT("zero") };
	for (const TCHAR* Candidate : Candidates)
	{
		if (!Fr.Cardinal.Contains(Candidate))
		{
			TArray<FString> WithUnused = Fr.Cardinal;
			WithUnused.Insert(Candidate, 0);
			Errors.Reset();
			TestFalse(FString::Printf(TEXT("fr rejects the unused form '%s'"), Candidate), LocHubValidator::Validate(TEXT("fr"), Source, PluralPattern(WithUnused), nullptr, Errors));
			TestTrue(TEXT("The engine names it unused"), AnyContains(Errors, TEXT("unused plural form")));
			break;
		}
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FLocHubValidatorRichTextAndGlyphsTest,
	"LocHub.Validator.RichTextAndGlyphs",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FLocHubValidatorRichTextAndGlyphsTest::RunTest(const FString& Parameters)
{
	TestTrue(TEXT("Balanced tags"), LocHubValidator::AreRichTextTagsBalanced(TEXT("<Bold>Hi</>"), TEXT("<Bold>Hi RU</>")));
	TestFalse(TEXT("Unclosed tag"), LocHubValidator::AreRichTextTagsBalanced(TEXT("<Bold>Hi</>"), TEXT("<Bold>Hi RU")));
	TestTrue(TEXT("<br> is self-closing"), LocHubValidator::AreRichTextTagsBalanced(TEXT("Line<br>Next"), TEXT("Line RU<br>Next RU")));
	TestTrue(TEXT("Self-closing tag"), LocHubValidator::AreRichTextTagsBalanced(TEXT("<img id=\"x\"/> Go"), TEXT("<img id=\"x\"/> Go RU")));
	TestTrue(TEXT("Same imbalance as the source"), LocHubValidator::AreRichTextTagsBalanced(TEXT("<Bold>Hi"), TEXT("<Bold>Hi RU")));

	TArray<FString> Errors;
	TestFalse(TEXT("Validate rejects broken tags"), LocHubValidator::Validate(TEXT("ru"), TEXT("<Bold>Hi</>"), TEXT("<Bold>Hi RU"), nullptr, Errors));

	if (!FLocHubGlyphChecker::IsAvailable())
	{
		AddInfo(TEXT("No Slate renderer in this process: glyph cases skipped."));
		return true;
	}

	const FString FontPath = FPaths::ConvertRelativePathToFull(FPaths::EngineContentDir() / TEXT("Slate/Fonts/Roboto-Regular.ttf"));
	if (!TestTrue(TEXT("Engine font exists"), FPaths::FileExists(FontPath)))
	{
		return false;
	}

	FLocHubGlyphChecker Checker;
	Checker.AddFontFile(FontPath);
	TestTrue(TEXT("Checker has a font"), Checker.HasFonts());

	Errors.Reset();
	TestTrue(TEXT("Latin letters, digits and a space are drawable"), Checker.Check(TEXT("AB 12"), Errors));
	TestEqual(TEXT("No glyph errors"), Errors.Num(), 0);

	// U+10FFFD (plane 16 private use) as a UTF-16 surrogate pair; no text font has it.
	FString PrivateUse = TEXT("A");
	PrivateUse.AppendChar(static_cast<TCHAR>(0xDBFF));
	PrivateUse.AppendChar(static_cast<TCHAR>(0xDFFD));
	Errors.Reset();
	TestFalse(TEXT("A private-use character is missing"), Checker.Check(PrivateUse, Errors));
	if (TestEqual(TEXT("One error per font"), Errors.Num(), 1))
	{
		TestTrue(TEXT("The error names the code point"), Errors[0].Contains(TEXT("U+10FFFD")));
	}

	Errors.Reset();
	TestFalse(TEXT("Validate uses the glyph checker"), LocHubValidator::Validate(TEXT("ru"), TEXT("A"), PrivateUse, &Checker, Errors));
	return true;
}

#endif
