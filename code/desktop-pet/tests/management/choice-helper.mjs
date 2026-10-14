// Drive the same page-owned picker used by pointer and keyboard users.
export async function choose(page,selector,value){
 await page.locator(selector).click();
 await page.locator('[role="option"][data-value='+JSON.stringify(value)+']').click();
}
export const choiceValue=locator=>locator.evaluate(n=>n.value);
