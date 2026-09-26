// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

using UnrealBuildTool;

public class LocHubEditor : ModuleRules
{
	public LocHubEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = ModuleRules.PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[]
			{
				"Core",
				"CoreUObject",
				"DeveloperSettings",
				"Engine",
			});

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				"DesktopPlatform",
				"HTTP",
				"HTTPServer",
				"Json",
				"Localization",
				"LocalizationService",
				"Projects",
				"PropertyEditor",
				"Settings",
				"Slate",
				"SlateCore",
				"ToolMenus",
				"UnrealEd",
				"WebBrowser",
			});
	}
}
