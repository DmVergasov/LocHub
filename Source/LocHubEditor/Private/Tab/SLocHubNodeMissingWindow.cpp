// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

#include "Tab/SLocHubNodeMissingWindow.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "HAL/PlatformProcess.h"
#include "ISettingsModule.h"
#include "LocHubEnvironment.h"
#include "Modules/ModuleManager.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SHyperlink.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SWindow.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "LocHubNodeMissingWindow"

namespace LocHubNodeMissingWindowPrivate
{
	constexpr float MessageWrapWidth = 420.0f;

	void OnDownloadNodeNavigated()
	{
		FPlatformProcess::LaunchURL(TEXT("https://nodejs.org/en/download"), nullptr, nullptr);
	}

	FReply OnOpenSettingsClicked()
	{
		FModuleManager::LoadModuleChecked<ISettingsModule>("Settings").ShowViewer(TEXT("Editor"), TEXT("Plugins"), TEXT("LocHub"));
		return FReply::Handled();
	}
}

void SLocHubNodeMissingWindow::Open(const FLocHubNodeCheck& InCheck)
{
	using namespace LocHubNodeMissingWindowPrivate;

	// A failed tool launch can be retried (or another tool launched) before the user closes the first window;
	// keep to one window instead of stacking a second copy of the same message.
	static TWeakPtr<SWindow> OpenWindow;
	if (const TSharedPtr<SWindow> Existing = OpenWindow.Pin())
	{
		Existing->BringToFront();
		return;
	}

	const TSharedRef<SWindow> Window = SNew(SWindow)
		.Title(LOCTEXT("Title", "LocHub: Node.js required"))
		.SizingRule(ESizingRule::Autosized)
		.SupportsMinimize(false)
		.SupportsMaximize(false);

	const TWeakPtr<SWindow> WeakWindow = Window;
	OpenWindow = Window;

	Window->SetContent(
		SNew(SVerticalBox)
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(16.0f, 16.0f, 16.0f, 8.0f)
		[
			SNew(STextBlock)
			.Text(FText::FromString(LocHubEnvironment::DescribeNodeProblem(InCheck)))
			.AutoWrapText(true)
			.WrapTextAt(MessageWrapWidth)
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(16.0f, 0.0f, 16.0f, 16.0f)
		[
			SNew(SHyperlink)
			.Text(LOCTEXT("DownloadNode", "Download Node.js"))
			.OnNavigate_Static(&OnDownloadNodeNavigated)
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.HAlign(HAlign_Right)
		.Padding(16.0f, 0.0f, 16.0f, 16.0f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.Padding(0.0f, 0.0f, 8.0f, 0.0f)
			[
				SNew(SButton)
				.Text(LOCTEXT("OpenSettings", "Open Settings"))
				.OnClicked_Static(&OnOpenSettingsClicked)
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			[
				SNew(SButton)
				.Text(LOCTEXT("Ok", "OK"))
				.OnClicked_Lambda([WeakWindow]() -> FReply
				{
					if (const TSharedPtr<SWindow> Pinned = WeakWindow.Pin())
					{
						Pinned->RequestDestroyWindow();
					}
					return FReply::Handled();
				})
			]
		]
	);

	const TSharedPtr<SWindow> RootWindow = FGlobalTabmanager::Get()->GetRootWindow();
	if (RootWindow.IsValid())
	{
		FSlateApplication::Get().AddWindowAsNativeChild(Window, RootWindow.ToSharedRef());
	}
	else
	{
		FSlateApplication::Get().AddWindow(Window);
	}
}

#undef LOCTEXT_NAMESPACE
